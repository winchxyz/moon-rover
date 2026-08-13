import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = 'https://api.glitch.fun/api';
const TITLE_ID = '6bd2c447-1770-441b-b94b-bceed5e81e87';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployToken = String(process.env.GLITCH_DISTRIBUTION_TOKEN || '').trim();
const titleToken = String(process.env.GLITCH_TITLE_TOKEN || '').trim();
const activate = process.env.GLITCH_ACTIVATE !== '0';

if (!deployToken.startsWith('gl_deploy_')) throw new Error('GLITCH_DISTRIBUTION_TOKEN is missing or invalid.');
if (!titleToken) throw new Error('GLITCH_TITLE_TOKEN is required for the deployed server.');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = String(process.env.GLITCH_VERSION || pkg.version);
if (version.length > 20) throw new Error('Deployment version must be 20 characters or fewer.');

const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'regolith-glitch-'));
const stage = path.join(stageRoot, 'build');
const zipPath = path.join(stageRoot, `regolith-${version}.zip`);

function copy(relative) {
  const source = path.join(ROOT, relative);
  const destination = path.join(stage, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

function authHeaders(json = true) {
  return {
    Authorization: `Bearer ${deployToken}`,
    Accept: 'application/json',
    ...(json ? { 'Content-Type': 'application/json' } : {})
  };
}

async function api(pathname, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers: authHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 500) }; }
  }
  if (!response.ok) {
    const message = data.message || data.error || data.code || `HTTP ${response.status}`;
    throw new Error(`Glitch deployment request failed: ${message}`);
  }
  return data;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function run() {
  fs.mkdirSync(stage, { recursive: true });
  for (const item of [
    'Dockerfile', 'index.html', 'runtime-config.js', 'package.json', 'server.js',
    'backend/glitch-proxy.js', 'src', 'vendor', 'assets'
  ]) copy(item);

  // This ignored file exists only in the temporary deployment artifact. The
  // static server cannot serve /backend/*, and the deploy token is never added.
  fs.writeFileSync(path.join(stage, 'backend', 'runtime-secrets.json'), JSON.stringify({
    GLITCH_BACKEND_ENABLED: '1',
    GLITCH_TITLE_TOKEN: titleToken,
    NODE_ENV: 'production',
    GLITCH_CLOUD_SAVES_ENABLED: '1',
    GLITCH_ANALYTICS_ENABLED: '1'
  }));

  const zipped = spawnSync('zip', ['-q', '-r', zipPath, '.'], { cwd: stage, stdio: 'inherit' });
  if (zipped.status !== 0) throw new Error('Could not create the deployment ZIP.');
  const file = fs.readFileSync(zipPath);
  console.log(`Packaged Regolith ${version} (${file.length} bytes).`);

  const initiated = await api(`/titles/${TITLE_ID}/deployments/multipart/initiate`, {
    method: 'POST', body: {}
  });
  if (!initiated.file_path) throw new Error('Glitch did not return a deployment file path.');

  if (initiated.is_local) {
    const upload = await fetch(initiated.upload_url, { method: 'PUT', body: file });
    if (!upload.ok) throw new Error(`Local deployment upload failed (${upload.status}).`);
  } else {
    if (!initiated.upload_id) throw new Error('Glitch did not return a multipart upload ID.');
    const partSize = 8 * 1024 * 1024;
    const partCount = Math.ceil(file.length / partSize);
    const partNumbers = Array.from({ length: partCount }, (_, index) => index + 1);
    const signed = await api(`/titles/${TITLE_ID}/deployments/multipart/urls`, {
      method: 'POST',
      body: { upload_id: initiated.upload_id, file_path: initiated.file_path, part_numbers: partNumbers }
    });
    const parts = [];
    for (const partNumber of partNumbers) {
      const start = (partNumber - 1) * partSize;
      const end = Math.min(file.length, start + partSize);
      const upload = await fetch(signed.urls[String(partNumber)], {
        method: 'PUT', body: file.subarray(start, end)
      });
      if (!upload.ok) throw new Error(`Deployment part ${partNumber} failed (${upload.status}).`);
      const etag = upload.headers.get('etag');
      if (!etag) throw new Error(`Deployment part ${partNumber} did not return an ETag.`);
      parts.push({ PartNumber: partNumber, ETag: etag });
      console.log(`Uploaded part ${partNumber}/${partCount}.`);
    }
    await api(`/titles/${TITLE_ID}/deployments/multipart/complete`, {
      method: 'POST',
      body: { upload_id: initiated.upload_id, file_path: initiated.file_path, parts }
    });
  }

  const confirmedResponse = await api(`/titles/${TITLE_ID}/deployments/confirm`, {
    method: 'POST',
    body: {
      file_path: initiated.file_path,
      version_string: version,
      build_type: 'production',
      deployment_type: 'node',
      entry_point: 'server.js'
    }
  });
  const confirmed = confirmedResponse.data || confirmedResponse;
  if (!confirmed.id) throw new Error('Glitch did not return a build ID.');
  console.log(`Build ${confirmed.id} confirmed with status ${confirmed.status}.`);

  let build = confirmed;
  for (let attempt = 0; attempt < 120 && build.status === 'processing'; attempt++) {
    await sleep(5000);
    const deployments = await api(`/titles/${TITLE_ID}/deployments`);
    const records = Array.isArray(deployments.data) ? deployments.data : [];
    build = records.find(record => record.id === confirmed.id) || build;
    if ((attempt + 1) % 6 === 0) console.log(`Build is still processing (${(attempt + 1) * 5}s).`);
  }

  if (build.status === 'failed') throw new Error(`Build processing failed: ${build.error_log || 'no error log returned'}`);
  if (build.status === 'processing') throw new Error('Build processing did not finish within 10 minutes.');
  if (activate && build.status !== 'ready') {
    const activatedResponse = await api(`/titles/${TITLE_ID}/deployments/${confirmed.id}/status`, {
      method: 'PUT', body: { status: 'ready' }
    });
    build = activatedResponse.data || activatedResponse;
  }
  console.log(`Deployment complete: build ${build.id}, status ${build.status}.`);
  if (build.cdn_url) console.log(`CDN: ${build.cdn_url}`);
}

try { await run(); }
finally { fs.rmSync(stageRoot, { recursive: true, force: true }); }
