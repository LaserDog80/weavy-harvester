/* global extractWeavyBoardInPage, buildArchive */
'use strict';

const button = document.getElementById('harvest');
const media = document.getElementById('media');
const status = document.getElementById('status');
const objectUrls = [];

function show(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
}

button.addEventListener('click', async () => {
  button.disabled = media.disabled = true;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || new URL(tab.url).origin !== 'https://app.weavy.ai') {
      throw new Error('Open a board at https://app.weavy.ai, then retry.');
    }
    show('Reading board state…');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: 'MAIN', func: extractWeavyBoardInPage
    });
    const board = results[0]?.result;
    if (!board) throw new Error('Extraction returned nothing. Reload the board and retry.');
    if (board.error) throw new Error(board.error);
    show(`Extracted ${board.nodes.length} nodes and ${board.edges.length} edges.`);
    const archive = await buildArchive(board, media.checked, show);
    const objectUrl = URL.createObjectURL(archive.blob);
    objectUrls.push(objectUrl);
    await chrome.downloads.download({ url: objectUrl, filename: archive.name, saveAs: true });
    const { downloaded, failed, skipped } = archive.summary;
    show(`ZIP handed to Chrome: ${downloaded} media saved, ${failed} failed, ${skipped} skipped. ` +
      'Check Downloads for completion. Failures are recorded in the JSON.', failed > 0);
    // Retain the URL while Chrome consumes it. Popup teardown releases it.
  } catch (error) {
    show(`${error.message || error} You can click Harvest board to retry.`, true);
  } finally {
    button.disabled = media.disabled = false;
  }
});
