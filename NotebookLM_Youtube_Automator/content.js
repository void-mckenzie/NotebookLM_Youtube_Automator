// This script is injected into YouTube playlist or video watch pages.
// Its purpose is to extract relevant video data and send it to the popup script.

/**
 * Determines the type of YouTube page (playlist or single video) and calls the appropriate extraction function.
 */
function runExtraction() {
    const currentUrl = window.location.href;

    if (currentUrl.includes("/playlist?list=")) {
        extractPlaylistDataAndSend();
    } else if (currentUrl.includes("/watch?v=")) {
        extractSingleVideoDataAndSend();
    } else {
        // This case should ideally not be reached if host_permissions are correctly set
        // and popup.js checks the URL before injecting.
        console.warn("Content Script: Not a recognized YouTube playlist or watch page for extraction.");
        chrome.runtime.sendMessage({
            type: "EXTRACTION_ERROR",
            error: "Page is not a YouTube playlist or video page (from content script)."
        }, handleResponse);
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

    console.log(`Content script: Extracted ${finalData.length} videos from playlist (${layout} layout). Sending to popup.`);
    chrome.runtime.sendMessage({ type: "PLAYLIST_DATA", data: finalData }, handleResponse);
}

/**
 * Extracts the title and link of the current single video on a YouTube watch page.
 * Sends the data as a single video object to the popup.
 */
function extractSingleVideoDataAndSend() {
    console.log("Content script: Starting single video extraction...");
    let title = "";
    let link = window.location.href; // The current page URL is the video link

    // Attempt 1: Try to get title from the 'og:title' meta tag (often more stable)
    const metaTitleElement = document.querySelector('meta[property="og:title"]');
    if (metaTitleElement && metaTitleElement.content) {
        title = metaTitleElement.content;
    }

    // Attempt 2: Fallback to common H1 selectors for the video title if meta tag fails
    // These selectors are highly likely to change with YouTube updates.
    if (!title) {
        const h1Selectors = [
            'h1.ytd-watch-metadata #video-title', // Older structure
            'h1.title yt-formatted-string.ytd-video-primary-info-renderer', // Another common structure
            'yt-formatted-string.ytd-watch-metadata[slot="title"]', // Newer structure often seen
            '#title h1 yt-formatted-string', // More generic title structure
            '#info-contents .title yt-formatted-string' // Another variation
        ];
        for (const selector of h1Selectors) {
            const h1TitleElement = document.querySelector(selector);
            if (h1TitleElement && h1TitleElement.textContent) {
                title = h1TitleElement.textContent.trim();
                break; // Found title, no need to check other selectors
            }
        }
    }

    if (title && link) {
        // Optional: Clean the link if it's part of a playlist view but we only want the specific video
        link = link.split('&list=')[0].split('&index=')[0];

        console.log(`Content script: Extracted single video: "${title}". Sending to popup.`);
        chrome.runtime.sendMessage({ type: "SINGLE_VIDEO_DATA", video: { title, link } }, handleResponse);
    } else {
        console.warn("Content script: Could not extract title for single video. All title selectors failed.");
        chrome.runtime.sendMessage({
            type: "EXTRACTION_ERROR",
            error: "Failed to extract title for the current video. Selectors might be outdated."
        }, handleResponse);
    }
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