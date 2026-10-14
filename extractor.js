// Adapted from the Weavy extractor identified in VENDORED.md.
// Injected as a self-contained function into the page MAIN world.
function extractWeavyBoardInPage() {
  try {
    const findState = () => {
      for (const key of ['__RF_STORE__', '__REACT_FLOW_STORE__', '__weavyStore__']) {
        try {
          const ref = window[key];
          if (ref && typeof ref.getState === 'function') {
            return { source: 'window.' + key, state: ref.getState() };
          }
        } catch (e) {}
      }
      const rfEl =
        document.querySelector('.react-flow') ||
        document.querySelector('[class*="reactflow"]') ||
        document.querySelector('[data-testid*="rf__"]');
      if (!rfEl) return null;

      const fiberKey = Object.keys(rfEl).find(
        (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
      );
      if (!fiberKey) return null;

      let fiber = rfEl[fiberKey];
      let depth = 0;
      while (fiber && depth++ < 200) {
        let hook = fiber.memoizedState;
        while (hook) {
          const s = (hook.queue && hook.queue.value) || hook.memoizedState;
          if (s && typeof s === 'object' && Array.isArray(s.nodes) && Array.isArray(s.edges)) {
            return { source: 'fiber.memoizedState (zustand)', state: s };
          }
          if (hook.baseState && typeof hook.baseState.getState === 'function') {
            return { source: 'fiber.memoizedState.baseState (store)', state: hook.baseState.getState() };
          }
          hook = hook.next;
        }
        const p = fiber.memoizedProps;
        if (p && Array.isArray(p.nodes) && Array.isArray(p.edges)) {
          return { source: 'fiber.memoizedProps', state: p };
        }
        fiber = fiber.return;
      }
      return null;
    };

    const found = findState();
    if (!found) {
      return { error: 'Could not locate React Flow state. Is the board fully loaded?' };
    }
    const state = found.state;
    const rawNodes = Array.isArray(state.nodes) ? state.nodes : [];
    const rawEdges = Array.isArray(state.edges) ? state.edges : [];

    if (!rawNodes.length) {
      return { error: 'Weavy board has zero nodes — cannot proceed.' };
    }
    if (!rawEdges.length) {
      return {
        error:
          'Weavy board has zero edges — provenance ancestry needs parent/child connections. Reload the board and retry.',
      };
    }

    const pickFirst = (...vals) => {
      for (const v of vals) {
        if (v !== undefined && v !== null && v !== '') return v;
      }
      return undefined;
    };

    // Deep walk a node's data harvesting every URL. Catches "hidden in plain
    // sight" public asset links that vary by node type and don't sit on a
    // canonical field. Cycle-safe via WeakSet.
    const URL_RE = /https?:\/\/[^\s"'<>)\]}]+/g;
    const collectUrls = (obj, out, seen) => {
      if (obj == null) return;
      if (typeof obj === 'string') {
        if (/^https?:\/\//.test(obj) && !/\s/.test(obj)) {
          try { new URL(obj); out.add(obj); return; } catch (_) {}
        }
        const m = obj.match(URL_RE);
        if (m) for (const u of m) out.add(u);
        return;
      }
      if (typeof obj !== 'object') return;
      if (seen.has(obj)) return;
      seen.add(obj);
      if (Array.isArray(obj)) {
        for (const v of obj) collectUrls(v, out, seen);
      } else {
        for (const v of Object.values(obj)) collectUrls(v, out, seen);
      }
    };

    // Looks like a media asset (image/video) the backend can fetch.
    const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif)(?:[?#]|$)/i;
    const VID_EXT_RE = /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i;
    const MEDIA_HOST_RE = /^(?:media\.weavy\.ai|res\.cloudinary\.com)$|^cdn\./i;
    const isImageUrl = (u) => IMG_EXT_RE.test(u);
    const isVideoUrl = (u) => VID_EXT_RE.test(u) || /\/video\/upload\//.test(u);
    const isMediaUrl = (u) => {
      if (isImageUrl(u) || isVideoUrl(u) || /\.(mp3|wav|ogg|m4a|flac|aac)(?:[?#]|$)/i.test(u)) return true;
      try {
        return MEDIA_HOST_RE.test(new URL(u).hostname);
      } catch (_) {
        return false;
      }
    };

    // Keep JSON-compatible source fields, with explicit diagnostics for runtime values.
    const serializationWarnings = [];
    const snapshot = (value, label) => {
      const ancestors = [];
      return JSON.parse(JSON.stringify(value, function (key, item) {
        if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'undefined') {
          serializationWarnings.push(`${label}: omitted non-JSON field ${key}`);
          return undefined;
        }
        if (typeof item === 'bigint') return item.toString();
        if (item && typeof item === 'object') {
          while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
          if (ancestors.includes(item)) {
            serializationWarnings.push(`${label}: circular field ${key}`);
            return '[Circular]';
          }
          ancestors.push(item);
        }
        return item;
      }));
    };

    const flattenNode = (n) => {
      const d = (n && n.data) || n || {};
      const out = {
        raw: snapshot(n, `node ${n.id}`),
        id: n.id,
        type: n.type,
        name: d.name || d.label || d.title || n.type,
      };

      if (d.model) {
        if (typeof d.model === 'string') out.model = { name: d.model };
        else if (typeof d.model === 'object') out.model = d.model;
      } else if (d.modelName) {
        out.model = { name: d.modelName };
      }

      if (typeof d.prompt === 'string') out.prompt = d.prompt;
      else if (typeof d.promptText === 'string') out.prompt = d.promptText;

      if (typeof d.imagePath === 'string') out.imagePath = d.imagePath;
      if (Array.isArray(d.outputMediaPaths)) {
        out.outputMediaPaths = d.outputMediaPaths.slice();
      }

      // Deep walk every string in node.data harvesting URLs. Filter to media-
      // looking ones (file extension or known CDN host). This catches assets
      // tucked into varied keys per node type (start_frame, reference_image,
      // params.image, generations[].uri, etc.) that the backend's auto-
      // thumbnail step can then fetch.
      const discoveredSet = new Set();
      collectUrls(n, discoveredSet, new WeakSet());
      const mediaUrls = [...discoveredSet].filter(isMediaUrl);
      const imageUrls = mediaUrls.filter(isImageUrl);

      // Prefer an image URL for the thumbnail (frontend renders <img>); fall
      // back to any media URL only if no image was found.
      if (!out.imagePath) {
        out.imagePath = imageUrls[0] || mediaUrls.find((u) => !isVideoUrl(u)) || null;
        if (out.imagePath === null) delete out.imagePath;
      }

      // Merge discovered media URLs into outputMediaPaths so the JSON
      // captures every public asset link, not just the canonical one.
      if (mediaUrls.length) {
        const merged = new Set(out.outputMediaPaths || []);
        for (const u of mediaUrls) merged.add(u);
        if (out.imagePath) merged.add(out.imagePath);
        if (merged.size > 1 || (merged.size === 1 && !out.imagePath)) {
          out.outputMediaPaths = Array.from(merged);
        }
      }

      out.assetUrls = mediaUrls;
      const params = { ...(d.parameters || {}), ...(d.params || {}) };
      const paramSrc = params;
      const dur = pickFirst(paramSrc.duration, d.duration);
      if (dur !== undefined) params.duration = dur;
      const res = pickFirst(paramSrc.resolution, d.resolution);
      if (res !== undefined) params.resolution = res;
      const ar = pickFirst(
        paramSrc.aspect_ratio,
        paramSrc.aspectRatio,
        d.aspect_ratio,
        d.aspectRatio
      );
      if (ar !== undefined) params.aspect_ratio = ar;
      const audio = pickFirst(paramSrc.generate_audio, d.generate_audio);
      if (audio !== undefined) params.generate_audio = !!audio;
      if (Object.keys(params).length) out.params = params;

      const seed = pickFirst(d.seed, params.seed, n.seed);
      if (seed !== undefined) out.seed = seed;
      out.timestamps = {};
      for (const key of ['createdAt', 'updatedAt', 'created_at', 'updated_at', 'timestamp']) {
        const value = pickFirst(d[key], n[key]);
        if (value !== undefined) out.timestamps[key] = value;
      }
      return snapshot(out, `normalized node ${n.id}`);
    };

    const flattenEdge = (e) => ({
      raw: snapshot(e, `edge ${e.id}`),
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle || '',
      targetHandle: e.targetHandle || '',
      sourceHandleType:
        e.sourceHandleType ||
        (e.data && e.data.type) ||
        (e.data && e.data.handleType) ||
        'any',
    });

    const nodes = rawNodes.map(flattenNode);
    const edges = rawEdges.map(flattenEdge);

    const boardId = location.pathname.split('/').filter(Boolean).pop() || 'unknown-board';
    const titleRaw = (document.title || '').trim();
    const boardTitle =
      titleRaw.replace(/\s*[—|·-]\s*Weavy.*$/i, '').trim() || boardId;

    return {
      schemaVersion: '1.0',
      extractorVersion: '0.1.0',
      exportSource: 'weavy-harvester',
      boardId,
      boardTitle,
      _sourceUrl: location.href,
      _extractedAt: new Date().toISOString(),
      _stateSource: found.source,
      nodes,
      edges,
      serializationWarnings,
    };
  } catch (e) {
    return { error: 'Extraction crashed: ' + (e && e.message ? e.message : String(e)) };
  }
}

