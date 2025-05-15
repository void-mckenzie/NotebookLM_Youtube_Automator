// This script runs when the popup is opened.
document.addEventListener('DOMContentLoaded', async function() {
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
        if (currentTabUrl.startsWith("https://notebooklm.google.com/")) {
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
    } else if (currentTabUrl && currentTabUrl.includes("youtube.com/watch")) {
      actionButton.textContent = "Add Current Video";
      actionButton.disabled = isNotebookLMAutomationRunning;
    } else {
      actionButton.textContent = "Open YouTube Video/Playlist";
      actionButton.disabled = true;
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
                currentPlaylistData.splice(index, 1);
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

    await displayDataInPopup(currentPlaylistData);
  }

  await loadData();

  chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
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
        sendResponse({ received: true });
        return true;
    }

    // YouTube extraction message handling (no changes here)
    actionButton.disabled = false;
    let responseMsg = { status: "Message processed by popup" };
    if (message.type === "PLAYLIST_DATA") {
      if (message.data && Array.isArray(message.data)) {
        currentPlaylistData = message.data;
        statusElement.textContent = `Playlist extracted: ${currentPlaylistData.length} videos.`;
        await saveData();
      } else {
        statusElement.textContent = "No videos found in playlist or data format was incorrect.";
      }
      responseMsg.status = "Playlist data received";
    } else if (message.type === "SINGLE_VIDEO_DATA") {
      if (message.video && message.video.title && message.video.link) {
        if (!currentPlaylistData.some(v => v.link === message.video.link)) {
            currentPlaylistData.push(message.video);
            statusElement.textContent = `Video "${message.video.title.substring(0,30)}..." added. Total: ${currentPlaylistData.length}.`;
            await saveData();
        } else {
            statusElement.textContent = `Video "${message.video.title.substring(0,30)}..." is already in the list.`;
        }
      } else {
        statusElement.textContent = "Failed to extract single video (missing title/link).";
      }
      responseMsg.status = "Single video data received";
    } else if (message.type === "EXTRACTION_ERROR") {
      statusElement.textContent = message.error || "An unknown extraction error occurred.";
      responseMsg.status = "Extraction error acknowledged";
    }
    await displayDataInPopup(currentPlaylistData);
    sendResponse(responseMsg);
    return true;
  });

  actionButton.addEventListener('click', async () => {
    if (isNotebookLMAutomationRunning) return;
    statusElement.textContent = 'Processing... Please wait.';
    actionButton.disabled = true;
    notebookLMStatusElement.textContent = "";
    try {
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (currentTab && currentTab.id && currentTab.url &&
          (currentTab.url.includes("youtube.com/playlist") || currentTab.url.includes("youtube.com/watch"))) {
        await chrome.scripting.executeScript({
          target: { tabId: currentTab.id },
          files: ['content.js']
        });
      } else {
        statusElement.textContent = 'Not a supported YouTube page for extraction.';
        await refreshButtonStates();
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
        await chrome.tabs.sendMessage(notebookLMTargetTabId, {
            action: "STOP_NOTEBOOKLM_AUTOMATION"
        });
        console.log("Stop signal sent to NotebookLM content script.");
        // Content script will send "stopped" status, handled by listener
        // which will set isNotebookLMAutomationRunning = false and clear storage state.
        // No need to reset batch counters here as the listener will handle it on "stopped"
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