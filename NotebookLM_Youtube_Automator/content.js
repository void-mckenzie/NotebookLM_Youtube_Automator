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
 * Extracts video titles and links from a YouTube playlist page.
 * Sends the data as an array of objects to the popup.
 */
function extractPlaylistDataAndSend() {
    console.log("Content script: Starting playlist extraction...");
    // IMPORTANT: This selector targets individual video entries in a playlist.
    // YouTube's class names can change, breaking this selector.
    // If extraction fails, this selector is the most likely culprit to check and update.
    const videoElements = document.querySelectorAll('ytd-playlist-video-renderer');

    if (!videoElements.length) {
        console.warn("Content script: No playlist video elements found with selector 'ytd-playlist-video-renderer'. Playlist might be empty or selector needs update.");
        // Send an empty array if no videos found, popup can decide how to interpret
        chrome.runtime.sendMessage({ type: "PLAYLIST_DATA", data: [] }, handleResponse);
        return;
    }

    const playlistData = [];
    videoElements.forEach(videoEl => {
        // Selectors for title and link within each video entry. Also prone to change.
        const titleElement = videoEl.querySelector('#video-title');
        const linkElement = videoEl.querySelector('a#video-title'); // Link is usually on the title's anchor tag

        if (titleElement && linkElement) {
            const title = titleElement.textContent.trim();
            let link = linkElement.href;

            // Optional: Clean up the link to remove playlist context if only the video ID is desired.
            // link = link.split('&list=')[0].split('&index=')[0];

            if (title && link) {
                playlistData.push({ title, link });
            }
        } else {
            console.warn("Content script: Could not find title or link for a playlist item. Selectors inside ytd-playlist-video-renderer might be outdated.", videoEl);
        }
    });

    console.log(`Content script: Extracted ${playlistData.length} videos from playlist. Sending to popup.`);
    chrome.runtime.sendMessage({ type: "PLAYLIST_DATA", data: playlistData }, handleResponse);
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