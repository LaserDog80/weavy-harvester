/* global makeZip */
'use strict';

// Pure archive helpers. URLs are kept verbatim, including signed query strings.
function safeName(value) {
  return String(value || 'board').normalize('NFKC')
    .replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 100) || 'board';
}

function nodeAssetUrls(node) {
  const found = new Set();
  // The extractor's deep scan includes inputs and thumbnails, as well as outputs.
  for (const value of [node.imagePath, ...(node.outputMediaPaths || []), ...(node.assetUrls || [])]) {
    if (typeof value === 'string' && /^https?:\/\//.test(value)) found.add(value);
  }
  return [...found];
}

function allowedMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'media.weavy.ai' &&
      !url.username && !url.password && (!url.port || url.port === '443');
  } catch (_) { return false; }
}

function mediaExtension(url, contentType) {
  const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/tiff': 'tif', 'video/mp4': 'mp4',
    'video/webm': 'webm', 'video/quicktime': 'mov', 'audio/mpeg': 'mp3',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' };
  const mime = (contentType || '').split(';')[0].trim().toLowerCase();
  if (extensions[mime]) return extensions[mime];
  const suffix = new URL(url).pathname.match(/\.([a-zA-Z0-9]{1,8})$/);
  return suffix ? suffix[1].toLowerCase() : 'bin';
}

function csvCell(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  // Prevent prompts and labels becoming spreadsheet formulas. JSON stays exact.
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function makeManifestCsv(board) {
  const rows = [['id', 'type', 'model', 'prompt', 'inputs', 'output_file']];
  for (const node of board.nodes) {
    const model = typeof node.model === 'string' ? node.model :
      node.model?.name || node.model?.id || (node.model ? JSON.stringify(node.model) : '');
    rows.push([node.id, node.type, model, node.prompt || '',
      board.edges.filter(edge => edge.target === node.id).map(edge => edge.source),
      (node.assets || []).filter(asset => asset.status === 'downloaded').map(asset => asset.file)]);
  }
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Classic ZIP has no ZIP64. Fail before overflow rather than emit a corrupt ZIP.
function checkZipLimits(entries) {
  if (entries.length > 65535) throw new Error('ZIP entry limit exceeded (65,535).');
  const encoder = new TextEncoder();
  let size = 22;
  for (const entry of entries) {
    const nameLength = encoder.encode(entry.name).length;
    if (nameLength > 65535 || entry.data.length >= 0xffffffff) throw new Error('ZIP file limit exceeded.');
    size += 76 + nameLength * 2 + entry.data.length;
  }
  if (size >= 0xffffffff) throw new Error('ZIP exceeds the classic 4 GiB limit.');
}

async function buildArchive(board, downloadMedia, report = () => {}, fetchMedia = fetch) {
  const entries = [];
  const filenames = new Set();
  board.mediaDownloadRequested = downloadMedia;
  board._archiveStartedAt = new Date().toISOString();
  let downloaded = 0;
  let failed = 0;
  let skipped = 0;
  const total = board.nodes.reduce((sum, node) => sum + nodeAssetUrls(node).length, 0);
  let count = 0;
  for (const node of board.nodes) {
    node.assets = [];
    let index = 0;
    for (const url of nodeAssetUrls(node)) {
      const asset = { url, status: 'skipped', file: null };
      node.assets.push(asset);
      index++;
      count++;
      if (!downloadMedia || !allowedMediaUrl(url)) {
        asset.reason = downloadMedia ? 'Outside permitted media host' : 'Download media unchecked';
        skipped++;
        continue;
      }
      report(`Fetching media ${count}/${total}`);
      try {
        // Never follow redirects to a host outside the manifest's permissions.
        const response = await fetchMedia(url, {
          credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(120000)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') || '';
        if (/^(text\/html|application\/json)/i.test(contentType)) throw new Error('Received a non-media response');
        const data = new Uint8Array(await response.arrayBuffer());
        if (!data.length) throw new Error('Empty media response');
        const base = `${safeName(node.id)}_${String(index).padStart(3, '0')}`;
        const ext = mediaExtension(url, contentType);
        let file = `media/${base}.${ext}`;
        let suffix = 1;
        while (filenames.has(file)) file = `media/${base}_${suffix++}.${ext}`;
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
        asset.sha256 = [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
        entries.push({ name: file, data });
        filenames.add(file);
        Object.assign(asset, { status: 'downloaded', file, bytes: data.length, contentType,
          fetchedAt: new Date().toISOString() });
        downloaded++;
      } catch (error) {
        asset.status = 'failed';
        asset.error = error.message || String(error);
        failed++;
      }
      // Check outside the per-asset catch: overflow must abort the whole ZIP.
      checkZipLimits(entries);
    }
  }
  board._archivedAt = new Date().toISOString();
  board.mediaSummary = { referenced: total, downloaded, failed, skipped };
  const encoder = new TextEncoder();
  const name = safeName(board.boardTitle || board.boardId);
  entries.push({ name: `${name}.json`, data: encoder.encode(JSON.stringify(board, null, 2)) });
  entries.push({ name: 'manifest.csv', data: encoder.encode(makeManifestCsv(board)) });
  checkZipLimits(entries);
  return { name: `${name}.zip`, blob: makeZip(entries), summary: board.mediaSummary };
}
