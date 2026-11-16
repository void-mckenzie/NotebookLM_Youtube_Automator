// This script is injected into YouTube playlist or video watch pages.
// Its purpose is to extract relevant video data and send it to the popup script.

/**
 * Extracts the video ID (exactly 11 chars) from any YouTube video URL shape:
 * watch?v=..., /shorts/<id>, /live/<id>, /embed/<id>, youtu.be/<id>.
 * Returns null for non-video URLs. The exact length matters: looser patterns
 * would match non-ID path segments (e.g. /embed/videoseries) and produce
 * broken watch links.
 */
function getYouTubeVideoId(rawUrl) {
    let id = null;
    try {
        const u = new URL(rawUrl, window.location.origin);
        const host = u.hostname.replace(/^www\./, "");
        if (host !== "youtube.com" && host !== "youtu.be" && !host.endsWith(".youtube.com")) return null;
        const v = u.searchParams.get("v");
        if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) id = v;
        if (!id && host === "youtu.be") {
            const seg = u.pathname.slice(1);
            if (/^[A-Za-z0-9_-]{11}$/.test(seg)) id = seg;
        }
        if (!id) {
            const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})/);
            if (m) id = m[1];
        }
    } catch (e) {
        return null;
    }
    // "videoseries" is YouTube's placeholder path token for playlist embeds
    // (/embed/videoseries?list=...) — not a video ID, and exactly 11 chars
    // long, so the length test alone cannot reject it.
    return id && id !== "videoseries" ? id : null;
}

/**
 * The canonical form of a video URL, so the same video added from different
 * surfaces (watch page, Shorts, playlist entries with &list=/&index= params)
 * always produces an identical link and can be deduplicated.
 */
function canonicalWatchUrl(rawUrl) {
    const id = getYouTubeVideoId(rawUrl);
    return id ? `https://www.youtube.com/watch?v=${id}` : rawUrl;
}

/**
 * Determines the type of YouTube page (playlist or single video) and calls the appropriate extraction function.
 */
function runExtraction() {
    const currentUrl = window.location.href;

    // Path-based playlist check: `list` may not be the first query param
    // (e.g. /playlist?app=desktop&list=...), which a substring test misses.
    let isPlaylistPage = false;
    try {
        isPlaylistPage = new URL(currentUrl).pathname === "/playlist";
    } catch (e) { /* malformed URL: fall through to the video check */ }

    if (isPlaylistPage) {
        extractPlaylistDataAndSend();
    } else if (getYouTubeVideoId(currentUrl)) {
        extractSingleVideoDataAndSend();
    } else {
        // This case should ideally not be reached if host_permissions are correctly set
        // and popup.js checks the URL before injecting.
        console.warn("Content Script: Not a recognized YouTube playlist or watch page for extraction.");
        sendOrStore({
            type: "EXTRACTION_ERROR",
            error: "Page is not a YouTube playlist or video page (from content script)."
        });
    }
}

/**
 * Finds the playlist video entry elements on the page.
 * YouTube's 2025+ redesign replaced ytd-playlist-video-renderer items with
 * yt-lockup-view-model elements, so both layouts are supported here.
 *
 * YouTube is a single-page app: pages visited earlier in the session (home feed,
 * search results, watch pages) stay mounted in the DOM, hidden, inside
 * ytd-page-manager — and their video cards are also yt-lockup-view-model
 * elements. A document-wide query would mix those stale cards into the
 * extraction after in-app navigation (a hard reload hides the symptom by
 * discarding them), so queries are scoped to the playlist page's own container,
 * with a hidden-ancestor filter as fallback if that container selector drifts.
 *
 * @returns {{items: NodeList|Element[], layout: 'legacy'|'lockup'}} The video entries and which layout matched.
 */
function getPlaylistItems() {
    const playlistPage = document.querySelector("ytd-browse[page-subtype='playlist']");

    if (playlistPage) {
        const legacyItems = playlistPage.querySelectorAll('ytd-playlist-video-renderer');
        if (legacyItems.length) return { items: legacyItems, layout: 'legacy' };

        // New layout: each entry is a yt-lockup-view-model whose h3 holds the title anchor.
        // Filtering on the h3 watch-link excludes any non-video lockups (e.g. promos).
        const lockupItems = playlistPage.querySelectorAll('yt-lockup-view-model');
        if (lockupItems.length) return { items: lockupItems, layout: 'lockup' };
    }

    // Fallback if the container selector ever drifts: whole-document query, but
    // ignore anything inside a hidden ancestor (stale SPA pages are hidden).
    let items = [...document.querySelectorAll('ytd-playlist-video-renderer')]
        .filter(el => !el.closest('[hidden]'));
    if (items.length) return { items, layout: 'legacy' };

    items = [...document.querySelectorAll('yt-lockup-view-model')]
        .filter(el => !el.closest('[hidden]'));
    if (items.length) return { items, layout: 'lockup' };

    return { items: [], layout: 'unknown' };
}

/**
 * Scrolls through the playlist to trigger YouTube's lazy loading so that all
 * videos are present in the DOM before extraction. Stops once the item count
 * stops growing (or the safety cap is hit).
 */
async function scrollPlaylistToLoadAll() {
    const MAX_ROUNDS = 60;
    const SCROLL_WAIT_MS = 700;
    let lastCount = -1;
    let stableRounds = 0;

    for (let round = 0; round < MAX_ROUNDS; round++) {
        const { items } = getPlaylistItems();
        const count = items.length;
        if (count > 0 && count === lastCount) {
            stableRounds++;
            if (stableRounds >= 2) break; // No new items after two scrolls: everything is loaded
        } else {
            stableRounds = 0;
        }
        lastCount = count;
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(resolve => setTimeout(resolve, SCROLL_WAIT_MS));
    }
    window.scrollTo(0, 0);
}

/**
 * Returns the playlist ID of the current page (the `list` query param),
 * or null when it cannot be determined.
 */
function getCurrentPlaylistId() {
    return new URLSearchParams(window.location.search).get("list");
}

/**
 * A watch link belongs to this playlist only when its `list` query param equals
 * the one in the page URL. This is structural, never text-based: the comparison
 * uses URL params, which are identical in every UI language.
 *
 * What it filters out:
 * - Playlist pages append a "Recommended playlists" shelf once scrolled to the
 *   end; its cards are yt-lockup-view-model elements whose watch links point at
 *   OTHER playlists (list=<other id>).
 * - Stale SPA pages kept mounted but hidden (home, search, watch) render watch
 *   links with no list param at all, which would leak in if the container
 *   scoping ever drifted.
 *
 * @param {string} link - absolute or relative watch URL
 * @param {string|null} currentListId
 */
function linkBelongsToCurrentPlaylist(link, currentListId) {
    if (!currentListId) return true; // no page-level ID: structural scoping is the only guard
    const listParam = new URL(link, window.location.origin).searchParams.get("list");
    return listParam === currentListId;
}

/**
 * Extracts video titles and links from a YouTube playlist page.
 * Sends the data as an array of objects to the popup.
 */
async function extractPlaylistDataAndSend() {
    console.log("Content script: Starting playlist extraction...");
    await scrollPlaylistToLoadAll();

    const { items: videoElements, layout } = getPlaylistItems();

    if (!videoElements.length) {
        console.warn("Content script: No playlist video elements found with selectors 'ytd-playlist-video-renderer' or 'yt-lockup-view-model'. Playlist might be empty or selectors need update.");
        // Send an empty array if no videos found, popup can decide how to interpret
        chrome.runtime.sendMessage({ type: "PLAYLIST_DATA", data: [] }, handleResponse);
        return;
    }

    const currentListId = getCurrentPlaylistId();
    const playlistData = [];
    videoElements.forEach(videoEl => {
        let title = "";
        let link = "";

        if (layout === 'lockup') {
            // New layout: the title anchor lives inside the entry's h3 heading.
            // Class names inside yt-lockup-view-model churn often, so match by tags.
            const linkElement = videoEl.querySelector('h3 a[href*="/watch?v="]');
            if (linkElement) {
                title = linkElement.textContent.trim();
                link = linkElement.href;
            }
        } else {
            // Legacy layout selectors.
            const titleElement = videoEl.querySelector('#video-title');
            const linkElement = videoEl.querySelector('a#video-title'); // Link is usually on the title's anchor tag
            if (titleElement && linkElement) {
                title = titleElement.textContent.trim();
                link = linkElement.href;
            }
        }

        if (title && link) {
            playlistData.push({ title, link });
        } else {
            console.warn("Content script: Could not find title or link for a playlist item. Selectors inside the video entry might be outdated.", videoEl);
        }
    });

    console.log(`Content script: Raw extraction found ${playlistData.length} entries (${layout} layout).`);

    // Strict pass: keep only entries whose link carries this playlist's own
    // `list` param (drops the "Recommended playlists" shelf cards and stale
    // SPA-page videos). If it filters everything out — e.g. YouTube changes its
    // link format — degrade to the structural result instead of returning empty.
    const ownPlaylistData = playlistData.filter(v => linkBelongsToCurrentPlaylist(v.link, currentListId));
    const finalData = ownPlaylistData.length ? ownPlaylistData : playlistData;
    if (!ownPlaylistData.length && playlistData.length) {
        console.warn("Content script: Strict list-param filter matched nothing; falling back to unfiltered structural extraction.");
    }

    // Normalize to canonical watch?v=<id> links (drops &list=/&index= context)
    // so the same video added from a playlist and from its watch page compares
    // equal for the popup's deduplication, and dedupe within the playlist.
    const seenIds = new Set();
    const normalizedData = [];
    for (const item of finalData) {
        const id = getYouTubeVideoId(item.link);
        if (id) {
            if (seenIds.has(id)) continue; // Same video twice in one playlist
            seenIds.add(id);
            normalizedData.push({ title: item.title, link: canonicalWatchUrl(item.link) });
        } else {
            normalizedData.push(item);
        }
    }

    console.log(`Content script: Extracted ${normalizedData.length} videos from playlist (${layout} layout). Sending to popup.`);
    sendOrStore({ type: "PLAYLIST_DATA", data: normalizedData });
}

/**
 * A video page reached by in-app (SPA) navigation keeps the previous page's
 * og:title — from the home feed that is literally "YouTube" — because YouTube
 * only sets that meta tag on full page loads. So og:title alone can't be
 * trusted: it may be missing (fresh page) or stale (SPA navigation). A title
 * candidate is only accepted when it is non-empty and not the generic
 * "YouTube" site name.
 */
function isUsableVideoTitle(title) {
    return Boolean(title) && title.trim().length > 0 && title.trim().toLowerCase() !== "youtube";
}

/**
 * Gathers video title candidates in priority order: the watch page's H1 title
 * elements, the document title (with YouTube's " - YouTube" suffix stripped),
 * and only then the og:title meta tag.
 *
 * og:title is LAST because YouTube only writes it on full page loads: after
 * in-app (SPA) navigation it keeps the PREVIOUS page's value — from the home
 * feed that is literally "YouTube", and from another video it is that video's
 * title. The DOM sources above are refreshed by the SPA navigation itself, so
 * they reflect the video actually on screen.
 */
function collectVideoTitleCandidates() {
    const candidates = [];

    // H1 selectors across YouTube's watch/shorts layouts. These are highly
    // likely to change with YouTube updates.
    const h1Selectors = [
        'h1.ytd-watch-metadata #video-title', // Older structure
        'h1.title yt-formatted-string.ytd-video-primary-info-renderer', // Another common structure
        'yt-formatted-string.ytd-watch-metadata[slot="title"]', // Newer structure often seen
        '#title h1 yt-formatted-string', // More generic title structure
        '#info-contents .title yt-formatted-string' // Another variation
    ];
    for (const selector of h1Selectors) {
        const h1TitleElement = document.querySelector(selector);
        if (h1TitleElement && h1TitleElement.textContent && h1TitleElement.textContent.trim()) {
            candidates.push(h1TitleElement.textContent.trim());
        }
    }

    if (document.title && document.title.trim()) {
        candidates.push(document.title.trim().replace(/\s*-\s*YouTube\s*$/i, "").trim());
    }

    const metaTitleElement = document.querySelector('meta[property="og:title"]');
    if (metaTitleElement && metaTitleElement.content) {
        candidates.push(metaTitleElement.content.trim());
    }

    return candidates;
}

/**
 * Waits briefly for a usable title to appear (the user may click "Add" while
 * the page is still hydrating), then falls back to any non-empty candidate.
 *
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<string|null>} The video title, or null if nothing usable.
 */
async function waitForVideoTitle(timeout = 8000) {
    const startTime = Date.now();
    let fallback = null;
    while (Date.now() - startTime <= timeout) {
        const candidates = collectVideoTitleCandidates();
        for (const candidate of candidates) {
            if (isUsableVideoTitle(candidate)) return candidate;
            if (!fallback && candidate) fallback = candidate;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return fallback;
}

/**
 * Extracts the title and link of the current single video on a YouTube watch,
 * Shorts, live, or embed page. Sends the data as a single video object to the
 * popup, with the link normalized to the canonical watch?v=<id> form.
 */
async function extractSingleVideoDataAndSend() {
    console.log("Content script: Starting single video extraction...");
    // Canonical watch link: works for watch, Shorts, live and embed pages, and
    // strips &list=/&index= playlist context from plain watch URLs.
    const link = canonicalWatchUrl(window.location.href);

    const title = await waitForVideoTitle();

    if (title && link) {
        console.log(`Content script: Extracted single video: "${title}". Sending to popup.`);
        sendOrStore({ type: "SINGLE_VIDEO_DATA", video: { title, link } });
    } else {
        console.warn("Content script: Could not extract title for single video. All title selectors failed.");
        sendOrStore({
            type: "EXTRACTION_ERROR",
            error: "Failed to extract title for the current video. Wait for the page to finish loading and try again."
        });
    }
}

/**
 * Sends an extraction result to the popup. Extraction can take a while
 * (playlist auto-scroll up to ~40s, title polling up to 8s) and any click
 * outside dismisses the popup — in that case sendMessage has no receiver and
 * the result would be lost. Instead of dropping it, persist the payload to
 * chrome.storage.local; the popup merges it the next time it opens.
 */
function sendOrStore(message) {
    chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
            console.warn("Content script: popup not open; saving extraction result for the next popup open.");
            try {
                chrome.storage.local.set({ pendingExtraction: message });
            } catch (e) {
                console.error("Content script: failed to persist pending extraction:", e);
            }
        } else {
            handleResponse(response);
        }
    });
}

/**
 * Handles the response from chrome.runtime.sendMessage (optional callback).
 * Useful for logging or debugging.
 * @param {Object} response - The response object sent back by the popup script.
 */
function handleResponse(response) {
    if (chrome.runtime.lastError) {
        // This error typically occurs if the popup was closed before the message could be sent/received.
        console.warn("Content script: Error sending message (popup might have closed):", chrome.runtime.lastError.message);
    } else if (response) {
        console.log("Content script: Popup responded:", response.status);
    } else {
        // console.log("Content script: No response from popup (this is normal if popup doesn't send one).");
    }
}

// --- Script Execution ---
// This ensures the extraction logic runs when the script is injected.
// A flag is used as a simple way to prevent re-execution if the script were somehow injected
// multiple times into the same page context without a full reload (less likely with executeScript target object).
// For this extension's flow (popup injects on demand), this mainly serves as a safeguard.
if (typeof window.ytVideoListManagerInjected === 'undefined') {
  runExtraction();
  window.ytVideoListManagerInjected = true;
} else {
  // If the popup is re-opened and the action button is clicked again on the same page,
  // a new instance of this content script will be injected and run.
  // This 'else' block is more for complex scenarios where a content script might persist across navigations.
  console.log("Content script: ytVideoListManagerInjected flag was already set. Re-running extraction for fresh data.");
  runExtraction(); // Allow re-running if re-injected
}