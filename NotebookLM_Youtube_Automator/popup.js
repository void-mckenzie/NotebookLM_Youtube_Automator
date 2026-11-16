// This script runs when the popup is opened.
document.addEventListener('DOMContentLoaded', async function() {

  /**
   * Extracts the video ID (exactly 11 chars) from any YouTube video URL shape
   * (watch?v=, /shorts/<id>, /live/<id>, /embed/<id>, youtu.be/<id>), or null
   * for non-video URLs. Used to dedupe list entries regardless of the surface
   * they were added from. The exact length rejects non-ID path segments
   * (e.g. /embed/videoseries) that would produce broken watch links.
   */
  function getYouTubeVideoId(rawUrl) {
    let id = null;
    try {
      const u = new URL(rawUrl);
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

  // True when the URL is any kind of YouTube video page (watch, Shorts, live, embed).
  function isYouTubeVideoPage(rawUrl) {
    return Boolean(getYouTubeVideoId(rawUrl));
  }

  // Rows stored before the title fix may carry the stale generic site name.
  function isJunkTitle(title) {
    return !title || !title.trim() || title.trim().toLowerCase() === "youtube";
  }

  /**
   * Merges extracted playlist items into the current list, keeping anything
   * already collected. Dedupes by video ID for YouTube links (exact URL
   * otherwise), heals stale "YouTube" titles on rows stored by older versions,
   * and refreshes matched rows to canonical links. Shared by the live message
   * handler and the pendingExtraction path (results that arrived while the
   * popup was closed).
   *
   * @returns {{added: number, skipped: number, healed: number}}
   */
  function mergePlaylistItems(items) {
    const existingLinks = new Set(currentPlaylistData.map(v => v.link));
    const idToIndex = new Map();
    currentPlaylistData.forEach((v, i) => {
      const id = getYouTubeVideoId(v.link);
      if (id) idToIndex.set(id, i);
    });
    const newItems = [];
    const newIds = new Set();
    let healed = 0;
    for (const item of (items || [])) {
      if (!item || !item.link) continue;
      const videoId = getYouTubeVideoId(item.link);
      if (videoId) {
        const existingIndex = idToIndex.get(videoId);
        if (existingIndex !== undefined) {
          const existing = currentPlaylistData[existingIndex];
          if (isJunkTitle(existing.title) && !isJunkTitle(item.title)) {
            existing.title = item.title;
            existing.link = item.link; // refresh legacy &list=/&index= links to canonical form
            healed++;
          }
          continue;
        }
        if (newIds.has(videoId)) continue; // same video twice in one extraction
        newIds.add(videoId);
      } else {
        if (existingLinks.has(item.link)) continue;
        existingLinks.add(item.link);
      }
      newItems.push(item);
    }
    currentPlaylistData = currentPlaylistData.concat(newItems);
    return { added: newItems.length, skipped: (items || []).length - newItems.length, healed };
  }

  /**
   * Adds one video to the list, or — if the same video is already present —
   * heals a stale "YouTube" title on the stored row. Returns a status string.
   */
  function mergeSingleVideo(video) {
    const incomingId = getYouTubeVideoId(video.link);
    const existingIndex = currentPlaylistData.findIndex(v =>
      v.link === video.link || (incomingId && getYouTubeVideoId(v.link) === incomingId));
    if (existingIndex === -1) {
      currentPlaylistData.push(video);
      return `Video "${video.title.substring(0, 30)}..." added. Total: ${currentPlaylistData.length}.`;
    }
    const existing = currentPlaylistData[existingIndex];
    if (isJunkTitle(existing.title) && !isJunkTitle(video.title)) {
      existing.title = video.title;
      existing.link = video.link;
      return `Video "${video.title.substring(0, 30)}..." is already in the list — title updated.`;
    }
    return `Video "${video.title.substring(0, 30)}..." is already in the list.`;
  }

  // Get references to HTML elements
  const actionButton = document.getElementById('actionButton');
  const resetButton = document.getElementById('resetAllButton');
  const statusElement = document.getElementById('status');
  const resultsContainer = document.getElementById('resultsTableContainer');

  const addToNotebookLMButton = document.getElementById('addToNotebookLMButton');
  const stopNotebookLMButton = document.getElementById('stopNotebookLMButton');
  const notebookLMStatusElement = document.getElementById('notebookLMStatus');

  let currentPlaylistData = [];
  const STORAGE_KEY = 'youtubeVideoManagerData';
  let isNotebookLMAutomationRunning = false;
  let notebookLMTargetTabId = null;

  // NEW state for ongoing automation batch
  let totalVideosInCurrentBatch = 0;
  let videosProcessedInCurrentBatch = 0;

  async function saveData() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: currentPlaylistData });
      console.log("Data saved to storage:", currentPlaylistData);
    } catch (error) {
      console.error("Error saving data to storage:", error);
      statusElement.textContent = "Error: Could not save data!";
    }
  }

  async function refreshButtonStates() {
    let currentTabUrl = null;
    let onNotebookLMPage = false;
    let onSpecificNotebookLMPage = false;

    try {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTab && activeTab.url) {
        currentTabUrl = activeTab.url;
        if (currentTabUrl.startsWith("https://notebook.google.com/")) {
            onNotebookLMPage = true;
            onSpecificNotebookLMPage = currentTabUrl.includes("/notebook/");
            notebookLMTargetTabId = activeTab.id;
        } else {
            onNotebookLMPage = false;
            onSpecificNotebookLMPage = false;
            notebookLMTargetTabId = null;
        }
      }
    } catch (e) {
      console.error("Failed to query current tab for button states:", e);
    }

    if (currentTabUrl && currentTabUrl.includes("youtube.com/playlist")) {
      actionButton.textContent = "Extract Playlist";
      actionButton.disabled = isNotebookLMAutomationRunning;
    } else if (currentTabUrl && isYouTubeVideoPage(currentTabUrl)) {
      actionButton.textContent = "Add Current Video";
      actionButton.disabled = isNotebookLMAutomationRunning;
    } else if (onNotebookLMPage) {
      actionButton.textContent = "On NotebookLM — switch tab to add";
      actionButton.disabled = true;
    } else {
      actionButton.textContent = "Add Current Tab";
      actionButton.disabled = isNotebookLMAutomationRunning;
    }

    resetButton.style.display = currentPlaylistData.length > 0 ? 'inline-block' : 'none';
    resetButton.disabled = isNotebookLMAutomationRunning;

    if (isNotebookLMAutomationRunning) {
        addToNotebookLMButton.disabled = true;
        addToNotebookLMButton.style.display = 'block';
        stopNotebookLMButton.disabled = false;
        stopNotebookLMButton.style.display = 'block';
    } else {
        stopNotebookLMButton.style.display = 'none';
        stopNotebookLMButton.disabled = true;
        if (currentPlaylistData.length > 0 && onSpecificNotebookLMPage) {
            addToNotebookLMButton.disabled = false;
            addToNotebookLMButton.title = "Click to add all listed videos to the current NotebookLM notebook.";
        } else if (currentPlaylistData.length === 0) {
            addToNotebookLMButton.disabled = true;
            addToNotebookLMButton.title = "Add videos to the list first.";
        } else if (!onSpecificNotebookLMPage && onNotebookLMPage) {
            addToNotebookLMButton.disabled = true;
            addToNotebookLMButton.title = "Please open a specific notebook within NotebookLM to use this feature.";
        } else {
            addToNotebookLMButton.disabled = true;
            addToNotebookLMButton.title = "Open NotebookLM and navigate into a notebook to use this feature.";
        }
    }
  }

  async function displayDataInPopup(dataToDisplay) {
    resultsContainer.innerHTML = "";

    if (!dataToDisplay || dataToDisplay.length === 0) {
      const currentStatus = statusElement.textContent;
      if (!currentStatus.includes("Loading stored data...") &&
          !currentStatus.includes("No stored data found") &&
          !currentStatus.includes("All videos cleared") &&
          !currentStatus.includes("Playlist extracted") &&
          !currentStatus.includes("Video added")) {
        statusElement.textContent = "No videos in the list.";
      }
      if (!isNotebookLMAutomationRunning && currentPlaylistData.length === 0) {
          notebookLMStatusElement.textContent = "";
      }
    }

    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Action', '#', 'Title', 'Link'].forEach(text => {
      const th = document.createElement('th');
      th.textContent = text;
      if (text === 'Action') th.classList.add('action-col');
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    if (dataToDisplay) {
        dataToDisplay.forEach((item, index) => {
            const row = document.createElement('tr');
            const cellAction = document.createElement('td');
            cellAction.classList.add('action-col');
            const deleteBtn = document.createElement('button');
            deleteBtn.textContent = 'Del';
            deleteBtn.classList.add('delete-btn');
            deleteBtn.title = 'Delete this row';
            deleteBtn.disabled = isNotebookLMAutomationRunning;
            deleteBtn.addEventListener('click', async () => {
                if (isNotebookLMAutomationRunning) return;
                // Delete by identity, not by captured index: a second click
                // during the await below would otherwise splice a shifted
                // index and silently delete an adjacent row.
                currentPlaylistData = currentPlaylistData.filter(v => v !== item);
                await saveData();
                await displayDataInPopup(currentPlaylistData);
                statusElement.textContent = `${currentPlaylistData.length} video(s) remaining.`;
                if (currentPlaylistData.length === 0) {
                    statusElement.textContent = "List is now empty.";
                }
                if (!isNotebookLMAutomationRunning) notebookLMStatusElement.textContent = "";
            });
            cellAction.appendChild(deleteBtn);
            row.appendChild(cellAction);

            const cellIndex = document.createElement('td');
            cellIndex.textContent = index + 1;
            row.appendChild(cellIndex);
            const cellTitle = document.createElement('td');
            cellTitle.textContent = item.title;
            row.appendChild(cellTitle);
            const cellLink = document.createElement('td');
            const anchor = document.createElement('a');
            anchor.href = item.link;
            anchor.textContent = "Open";
            anchor.title = item.link;
            anchor.target = '_blank';
            cellLink.appendChild(anchor);
            row.appendChild(cellLink);
            tbody.appendChild(row);
        });
    }
    table.appendChild(tbody);
    resultsContainer.appendChild(table);
    await refreshButtonStates();
  }

  async function loadData() {
    statusElement.textContent = "Loading stored data...";
    actionButton.disabled = true;
    addToNotebookLMButton.disabled = true;

    try {
      const result = await chrome.storage.local.get([STORAGE_KEY]);
      if (result[STORAGE_KEY] && Array.isArray(result[STORAGE_KEY])) {
        currentPlaylistData = result[STORAGE_KEY];
        if (currentPlaylistData.length > 0) {
            statusElement.textContent = `${currentPlaylistData.length} video(s) loaded.`;
        } else {
            statusElement.textContent = "No stored data. Add videos or extract a playlist.";
        }
      } else {
        currentPlaylistData = [];
        statusElement.textContent = "No stored data. Add videos or extract a playlist.";
      }
    } catch (error) {
      console.error("Error loading data from storage:", error);
      currentPlaylistData = [];
      statusElement.textContent = "Error: Could not load data!";
    }

    const { notebookLMAutomationState } = await chrome.storage.local.get(['notebookLMAutomationState']);
    if (notebookLMAutomationState && notebookLMAutomationState.isRunning) {
        isNotebookLMAutomationRunning = true;
        notebookLMTargetTabId = notebookLMAutomationState.tabId;
        totalVideosInCurrentBatch = notebookLMAutomationState.totalInBatch || 0;
        videosProcessedInCurrentBatch = notebookLMAutomationState.processedInBatch || 0;
        notebookLMStatusElement.textContent = notebookLMAutomationState.lastMessage ||
            (totalVideosInCurrentBatch > 0 ? `Automation was in progress: ${videosProcessedInCurrentBatch} of ${totalVideosInCurrentBatch} processed.` : "Automation was in progress...");
    } else {
        isNotebookLMAutomationRunning = false;
        totalVideosInCurrentBatch = 0;
        videosProcessedInCurrentBatch = 0;
    }

    // Pick up extraction results that arrived while the popup was closed
    // (content.js persists them to storage when the message has no receiver).
    const { pendingExtraction } = await chrome.storage.local.get(['pendingExtraction']);
    if (pendingExtraction && pendingExtraction.type) {
      try {
        if (pendingExtraction.type === "PLAYLIST_DATA" && Array.isArray(pendingExtraction.data)) {
          const { added, skipped, healed } = mergePlaylistItems(pendingExtraction.data);
          let pendingMsg = `Added while popup was closed: ${added} new video(s)` +
            (skipped > 0 ? `, ${skipped} already in list` : "") +
            `. Total: ${currentPlaylistData.length}.`;
          if (healed > 0) pendingMsg += ` ${healed} title(s) updated.`;
          statusElement.textContent = pendingMsg;
          await saveData();
        } else if (pendingExtraction.type === "SINGLE_VIDEO_DATA" && pendingExtraction.video) {
          statusElement.textContent = mergeSingleVideo(pendingExtraction.video);
          await saveData();
        } else if (pendingExtraction.type === "EXTRACTION_ERROR" && pendingExtraction.error) {
          statusElement.textContent = pendingExtraction.error;
        }
      } finally {
        await chrome.storage.local.remove('pendingExtraction');
      }
    }

    await displayDataInPopup(currentPlaylistData);
  }

  await loadData();

  // The listener must NOT be async: Chrome only keeps the response channel
  // open for a listener that synchronously returns literal `true` (a returned
  // Promise closes the port and every sendResponse call becomes a dead write).
  // The async work happens in handleMessage; the wrapper returns true up front.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message).then((response) => {
      try { sendResponse(response); } catch (e) { /* channel already closed */ }
    }).catch((err) => {
      console.error("Popup message handler error:", err);
      try { sendResponse({ status: "handler_error" }); } catch (e) { /* channel already closed */ }
    });
    return true;
  });

  async function handleMessage(message) {
    console.log("Popup received message:", message);

    if (message.type === "NOTEBOOKLM_AUTOMATION_STATUS") {
        let statusMsg = message.data;
        notebookLMStatusElement.className = '';

        if (message.status === "progress") {
            // Message from content script is like "Adding video X of Y..."
            // This Y is totalVideosInCurrentBatch.
            notebookLMStatusElement.textContent = statusMsg;
            if (isNotebookLMAutomationRunning) { // Persist last message
                await chrome.storage.local.set({
                    notebookLMAutomationState: {
                        isRunning: true, tabId: notebookLMTargetTabId,
                        totalInBatch: totalVideosInCurrentBatch,
                        processedInBatch: videosProcessedInCurrentBatch,
                        lastMessage: statusMsg
                    }
                });
            }
        } else if (message.status === "video_success_batch") {
            const addedLinks = Array.isArray(message.video_links_added) ? message.video_links_added : [];
            videosProcessedInCurrentBatch += addedLinks.length;
            const initialLength = currentPlaylistData.length;
            currentPlaylistData = currentPlaylistData.filter(v => !addedLinks.includes(v.link));

            if (currentPlaylistData.length < initialLength) {
                await saveData();
                await displayDataInPopup(currentPlaylistData);
                console.log(`Batch: ${addedLinks.length} link(s) removed. Processed: ${videosProcessedInCurrentBatch}/${totalVideosInCurrentBatch}`);
            }

            statusMsg = `${message.data} (${videosProcessedInCurrentBatch} of ${totalVideosInCurrentBatch} done).`;
            notebookLMStatusElement.textContent = statusMsg;

            if (isNotebookLMAutomationRunning) {
                await chrome.storage.local.set({
                     notebookLMAutomationState: {
                        isRunning: true, tabId: notebookLMTargetTabId,
                        totalInBatch: totalVideosInCurrentBatch,
                        processedInBatch: videosProcessedInCurrentBatch,
                        lastMessage: statusMsg
                    }
                });
            }

            if (videosProcessedInCurrentBatch >= totalVideosInCurrentBatch || currentPlaylistData.length === 0) {
                const finalMessage = currentPlaylistData.length === 0 ?
                    `All ${totalVideosInCurrentBatch} sources added. List is now empty!` :
                    `Complete: ${totalVideosInCurrentBatch} sources processed. ${currentPlaylistData.length} remain in list.`;

                notebookLMStatusElement.textContent = finalMessage;
                notebookLMStatusElement.classList.add('success');
                isNotebookLMAutomationRunning = false;
                totalVideosInCurrentBatch = 0;
                videosProcessedInCurrentBatch = 0;
                await chrome.storage.local.remove(['notebookLMAutomationState']);
            }
        } else if (message.status === "video_success") {
            videosProcessedInCurrentBatch++;
            const videoLinkToRemove = message.video_link_added;
            const initialLength = currentPlaylistData.length;
            currentPlaylistData = currentPlaylistData.filter(v => v.link !== videoLinkToRemove);

            if (currentPlaylistData.length < initialLength) {
                await saveData(); // Save updated list (with one less video)
                await displayDataInPopup(currentPlaylistData); // Refresh table, row is now gone
                console.log(`Video removed: ${videoLinkToRemove}. Processed in batch: ${videosProcessedInCurrentBatch}/${totalVideosInCurrentBatch}`);
            } else {
                console.warn("Video_success: Video link not found for removal:", videoLinkToRemove);
            }

            statusMsg = `${message.data} (${videosProcessedInCurrentBatch} of ${totalVideosInCurrentBatch} done).`;
            notebookLMStatusElement.textContent = statusMsg;

            if (isNotebookLMAutomationRunning) { // Persist progress
                await chrome.storage.local.set({
                     notebookLMAutomationState: {
                        isRunning: true, tabId: notebookLMTargetTabId,
                        totalInBatch: totalVideosInCurrentBatch,
                        processedInBatch: videosProcessedInCurrentBatch,
                        lastMessage: statusMsg
                    }
                });
            }

            // Check if batch is complete based on counters
            if (videosProcessedInCurrentBatch >= totalVideosInCurrentBatch || currentPlaylistData.length === 0) {
                const finalMessage = currentPlaylistData.length === 0 ?
                    `All ${totalVideosInCurrentBatch} videos added. List is now empty!` :
                    `Batch complete: All ${totalVideosInCurrentBatch} videos processed. ${currentPlaylistData.length} video(s) remain in list for next batch.`;

                notebookLMStatusElement.textContent = finalMessage;
                notebookLMStatusElement.classList.add('success');
                isNotebookLMAutomationRunning = false;
                // Reset batch counters for the next run
                totalVideosInCurrentBatch = 0;
                videosProcessedInCurrentBatch = 0;
                await chrome.storage.local.remove(['notebookLMAutomationState']);
            }
        } else if (message.status === "complete") { // Content script finished its loop
            notebookLMStatusElement.textContent = message.data + ` (Processed ${videosProcessedInCurrentBatch} of ${totalVideosInCurrentBatch} in this batch).`;
            notebookLMStatusElement.classList.add('success');
            isNotebookLMAutomationRunning = false;
            totalVideosInCurrentBatch = 0; // Reset batch counters
            videosProcessedInCurrentBatch = 0;
            await chrome.storage.local.remove(['notebookLMAutomationState']);
            await displayDataInPopup(currentPlaylistData); // Final refresh
        } else if (message.status === "error" || message.status === "stopped") {
            notebookLMStatusElement.textContent = message.data;
            if(message.status === "error") notebookLMStatusElement.classList.add('error');
            isNotebookLMAutomationRunning = false;
            // Don't reset batch counters here if stopped, user might resume the "batch"
            // by restarting. The counters will be reset on next "Add to NotebookLM" click.
            // However, clear the running state from storage.
            const stateToStore = {
                isRunning: false, // Mark as not running
                tabId: notebookLMTargetTabId,
                totalInBatch: totalVideosInCurrentBatch, // Keep batch info in case needed for context on next run
                processedInBatch: videosProcessedInCurrentBatch,
                lastMessage: message.data
            };
            if(message.status === "stopped") { // If explicitly stopped, clear running state for next time.
                 totalVideosInCurrentBatch = 0;
                 videosProcessedInCurrentBatch = 0;
                 await chrome.storage.local.remove(['notebookLMAutomationState']);
            } else { // On error, preserve for context
                 await chrome.storage.local.set({ notebookLMAutomationState: stateToStore });
            }

        } else { // Other progress, etc.
            notebookLMStatusElement.textContent = statusMsg;
        }
        await refreshButtonStates();
        return { received: true };
    }

    // YouTube extraction message handling (no changes here)
    actionButton.disabled = false;
    let responseMsg = { status: "Message processed by popup" };
    if (message.type === "PLAYLIST_DATA") {
      if (message.data && Array.isArray(message.data)) {
        const { added, skipped, healed } = mergePlaylistItems(message.data);
        let mergeMsg = skipped > 0
          ? `Playlist extracted: ${added} new video(s), ${skipped} already in list. Total: ${currentPlaylistData.length}.`
          : `Playlist extracted: ${added} videos. Total: ${currentPlaylistData.length}.`;
        if (healed > 0) mergeMsg += ` ${healed} title(s) updated.`;
        statusElement.textContent = mergeMsg;
        await saveData();
      } else {
        statusElement.textContent = "No videos found in playlist or data format was incorrect.";
      }
      responseMsg.status = "Playlist data received";
    } else if (message.type === "SINGLE_VIDEO_DATA") {
      if (message.video && message.video.title && message.video.link) {
        // mergeSingleVideo matches by video ID (not exact link) so the same
        // video added from a playlist, a watch page, or a Short is recognized
        // as the same video, and heals stale "YouTube" titles.
        statusElement.textContent = mergeSingleVideo(message.video);
        await saveData();
      } else {
        statusElement.textContent = "Failed to extract single video (missing title/link).";
      }
      responseMsg.status = "Single video data received";
    } else if (message.type === "EXTRACTION_ERROR") {
      statusElement.textContent = message.error || "An unknown extraction error occurred.";
      responseMsg.status = "Extraction error acknowledged";
    }
    await displayDataInPopup(currentPlaylistData);
    return responseMsg;
  }

  actionButton.addEventListener('click', async () => {
    if (isNotebookLMAutomationRunning) return;
    statusElement.textContent = 'Processing... Please wait.';
    actionButton.disabled = true;
    notebookLMStatusElement.textContent = "";
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = currentTab && currentTab.url;
      if (!url) {
        statusElement.textContent = 'Could not read current tab URL.';
        await refreshButtonStates();
        return;
      }
      if (url.includes("youtube.com/playlist") || isYouTubeVideoPage(url)) {
        await chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          files: ['content.js']
        });
      } else if (url.startsWith("https://notebook.google.com/")) {
        statusElement.textContent = 'Switch to the page you want to add.';
        await refreshButtonStates();
      } else {
        const title = (currentTab.title && currentTab.title.trim()) || url;
        if (!currentPlaylistData.some(v => v.link === url)) {
          currentPlaylistData.push({ title, link: url });
          statusElement.textContent = `Added "${title.substring(0, 30)}${title.length > 30 ? '...' : ''}". Total: ${currentPlaylistData.length}.`;
          await saveData();
        } else {
          statusElement.textContent = `"${title.substring(0, 30)}..." is already in the list.`;
        }
        await displayDataInPopup(currentPlaylistData);
      }
    } catch (error) {
      console.error("Error in popup during script execution:", error);
      statusElement.textContent = 'Error initiating extraction. Check console.';
      await refreshButtonStates();
    }
  });

  resetButton.addEventListener('click', async () => {
    if (isNotebookLMAutomationRunning) return;
    currentPlaylistData = [];
    statusElement.textContent = "Clearing data...";
    notebookLMStatusElement.textContent = "";
    totalVideosInCurrentBatch = 0; // Also reset batch counters
    videosProcessedInCurrentBatch = 0;
    try {
        await chrome.storage.local.remove(STORAGE_KEY);
        await chrome.storage.local.remove('notebookLMAutomationState'); // Clear any automation state
        console.log("Data cleared from storage.");
        statusElement.textContent = "All videos cleared. Storage reset.";
    } catch (error) {
        console.error("Error clearing data from storage:", error);
        statusElement.textContent = "Error clearing storage! List is cleared locally.";
    }
    await displayDataInPopup(currentPlaylistData);
    if (currentPlaylistData.length === 0 && !statusElement.textContent.includes("Error clearing storage")) {
        statusElement.textContent = "All videos cleared. Storage reset.";
    }
  });

  addToNotebookLMButton.addEventListener('click', async () => {
    if (currentPlaylistData.length === 0) {
        notebookLMStatusElement.textContent = "No videos in the list to add.";
        notebookLMStatusElement.className = 'error';
        return;
    }
    if (!notebookLMTargetTabId) {
        notebookLMStatusElement.textContent = "Could not identify NotebookLM tab. Please ensure you are on a NotebookLM notebook page.";
        notebookLMStatusElement.className = 'error';
        refreshButtonStates();
        return;
    }

    isNotebookLMAutomationRunning = true;
    // Initialize batch counters for this new run
    totalVideosInCurrentBatch = currentPlaylistData.length;
    videosProcessedInCurrentBatch = 0;
    const initialStatusMessage = `Starting to add ${totalVideosInCurrentBatch} videos...`;

    await chrome.storage.local.set({
        notebookLMAutomationState: {
            isRunning: true,
            tabId: notebookLMTargetTabId,
            lastMessage: initialStatusMessage,
            totalInBatch: totalVideosInCurrentBatch,
            processedInBatch: videosProcessedInCurrentBatch
        }
    });
    notebookLMStatusElement.textContent = initialStatusMessage;
    notebookLMStatusElement.className = '';
    await refreshButtonStates();

    try {
        await chrome.scripting.executeScript({
            target: { tabId: notebookLMTargetTabId },
            files: ['notebooklm_content_script.js']
        });

        setTimeout(async () => {
            try {
                const videosToSend = [...currentPlaylistData]; // Send a copy of the current list
                chrome.tabs.sendMessage(notebookLMTargetTabId, {
                    action: "ADD_VIDEOS_TO_NOTEBOOKLM",
                    videos: videosToSend
                }, function(response) {
                    if (chrome.runtime.lastError) {
                        console.error("Error sending ADD_VIDEOS_TO_NOTEBOOKLM:", chrome.runtime.lastError.message);
                        notebookLMStatusElement.textContent = `Error starting automation: ${chrome.runtime.lastError.message}. Try reloading NotebookLM.`;
                        notebookLMStatusElement.className = 'error';
                        isNotebookLMAutomationRunning = false;
                        chrome.storage.local.remove(['notebookLMAutomationState']); // Clear running state
                        totalVideosInCurrentBatch = 0; // Reset batch counters
                        videosProcessedInCurrentBatch = 0;
                        refreshButtonStates();
                        return;
                    }
                    if (response) {
                        console.log("Initial response from NotebookLM content script:", response);
                        if (response.status === "progress" || response.status === "error") {
                             notebookLMStatusElement.textContent = response.data;
                             if(response.status === "error") notebookLMStatusElement.className = 'error';
                        }
                        if (response.status === "error") {
                            isNotebookLMAutomationRunning = false;
                            chrome.storage.local.remove(['notebookLMAutomationState']);
                            totalVideosInCurrentBatch = 0;
                            videosProcessedInCurrentBatch = 0;
                            refreshButtonStates();
                        }
                    } else {
                        console.log("No immediate synchronous response to ADD_VIDEOS_TO_NOTEBOOKLM. Expecting async updates.");
                    }
                });
            } catch (e) {
                console.error("Error in setTimeout sending message to NotebookLM content script:", e);
                notebookLMStatusElement.textContent = `Error communicating with NotebookLM page: ${e.message}.`;
                notebookLMStatusElement.className = 'error';
                isNotebookLMAutomationRunning = false;
                await chrome.storage.local.remove(['notebookLMAutomationState']);
                totalVideosInCurrentBatch = 0;
                videosProcessedInCurrentBatch = 0;
                await refreshButtonStates();
            }
        }, 300);

    } catch (error) {
        console.error("Error in Add to NotebookLM click handler (script injection):", error);
        notebookLMStatusElement.textContent = `Injection Error: ${error.message}`;
        notebookLMStatusElement.className = 'error';
        isNotebookLMAutomationRunning = false;
        await chrome.storage.local.remove(['notebookLMAutomationState']);
        totalVideosInCurrentBatch = 0;
        videosProcessedInCurrentBatch = 0;
        await refreshButtonStates();
    }
  });

  stopNotebookLMButton.addEventListener('click', async () => {
    if (!isNotebookLMAutomationRunning || !notebookLMTargetTabId) {
        console.warn("Stop button clicked but automation not running or no target tab.");
        isNotebookLMAutomationRunning = false; // Ensure flag is reset
        totalVideosInCurrentBatch = 0; // Reset batch info
        videosProcessedInCurrentBatch = 0;
        await chrome.storage.local.remove(['notebookLMAutomationState']);
        await refreshButtonStates();
        return;
    }

    notebookLMStatusElement.textContent = 'Sending stop signal to NotebookLM...';
    stopNotebookLMButton.disabled = true;

    try {
        const ack = await chrome.tabs.sendMessage(notebookLMTargetTabId, {
            action: "STOP_NOTEBOOKLM_AUTOMATION"
        });
        console.log("Stop signal sent to NotebookLM content script:", ack);
        // Clear the running state here rather than waiting for the content
        // script's "stopped" message: if the popup was closed and reopened,
        // nothing is actually running anymore and that message never comes —
        // without this the popup would be stuck in "running" forever. When a
        // run IS active, the async "stopped" message lands afterwards and
        // this cleanup is simply idempotent.
        isNotebookLMAutomationRunning = false;
        totalVideosInCurrentBatch = 0;
        videosProcessedInCurrentBatch = 0;
        await chrome.storage.local.remove(['notebookLMAutomationState']);
        notebookLMStatusElement.textContent = "Stopped.";
        await refreshButtonStates();
    } catch (error) {
        console.error("Error sending stop signal to NotebookLM content script:", error);
        notebookLMStatusElement.textContent = `Error sending stop signal: ${error.message}. Manually check NotebookLM.`;
        notebookLMStatusElement.className = 'error';
        isNotebookLMAutomationRunning = false;
        totalVideosInCurrentBatch = 0;
        videosProcessedInCurrentBatch = 0;
        await chrome.storage.local.remove(['notebookLMAutomationState']);
        await refreshButtonStates();
    }
  });

  window.addEventListener('unload', async () => {
    if (isNotebookLMAutomationRunning && notebookLMTargetTabId) {
      await chrome.storage.local.set({
        notebookLMAutomationState: {
          isRunning: true,
          tabId: notebookLMTargetTabId,
          lastMessage: notebookLMStatusElement.textContent || "Automation in progress...",
          totalInBatch: totalVideosInCurrentBatch, // Persist batch info
          processedInBatch: videosProcessedInCurrentBatch
        }
      });
    } else {
      // If not running, or no tab, ensure no stale automation state persists for next open
      // (unless it was an error state we want to preserve for context, handled in listener)
      const state = await chrome.storage.local.get(['notebookLMAutomationState']);
      if (state.notebookLMAutomationState && !state.notebookLMAutomationState.isRunning) {
          // It's already marked as not running, fine to leave as is or clear
      } else if (!isNotebookLMAutomationRunning) { // If explicitly not running (e.g. completed, stopped)
          await chrome.storage.local.remove(['notebookLMAutomationState']);
      }
    }
  });
});