// notebooklm_content_script.js

console.log("NotebookLM Content Script Loaded (v2 - Language Agnostic)");

const NOTEBOOKLM_SELECTORS = {
    addSourceButton: 'button.add-source-button',
    youtubeLinkInput: 'input[formcontrolname="newUrl"]',
    submitButton: 'button[type="submit"]',
};

let stopAutomationSignal = false;
let currentResponseCallback = null;

// --- Helper Functions ---

function waitForElement(selector, parent = document, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (stopAutomationSignal) {
                clearInterval(interval);
                reject(new Error("Automation stopped by user during waitForElement."));
                return;
            }
            const element = parent.querySelector(selector);
            if (element && element.offsetParent !== null) {
                clearInterval(interval);
                resolve(element);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Timeout: Element "${selector}" not found or not visible after ${timeout}ms.`));
            }
        }, 100);
    });
}

function waitForElementToDisappear(selector, parent = document, timeout = 10000) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (stopAutomationSignal) {
                clearInterval(interval);
                reject(new Error("Automation stopped by user during waitForElementToDisappear."));
                return;
            }
            const element = parent.querySelector(selector);
            if (!element || element.offsetParent === null) {
                clearInterval(interval);
                resolve();
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Timeout: Element "${selector}" still present after ${timeout}ms.`));
            }
        }, 100);
    });
}

/**
 * FINAL UPDATED HELPER: Finds the YouTube source type chip by looking for the unique icon
 * and then finding its correct clickable parent, which is a <mat-chip>.
 * @param {Element} searchContext - The element to search within (e.g., the dialog).
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<Element>} Resolves with the clickable chip element.
 */
function findYoutubeChip(searchContext, timeout = 5000) {
    console.log("Searching for YouTube chip using its icon (v4 method)...");
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (stopAutomationSignal) {
                clearInterval(interval);
                reject(new Error("Automation stopped by user during findYoutubeChip."));
                return;
            }

            const icons = searchContext.querySelectorAll('mat-icon');
            let youtubeChip = null;

            for (const icon of icons) {
                if ((icon.textContent || "").trim() === 'video_youtube') {
                    // CORRECTED: The clickable parent is a 'mat-chip' with a tabindex.
                    const chip = icon.closest('mat-chip[tabindex="0"]');
                    if (chip && chip.offsetParent !== null) {
                        youtubeChip = chip;
                        break;
                    }
                }
            }

            if (youtubeChip) {
                clearInterval(interval);
                console.log("Found YouTube chip:", youtubeChip);
                resolve(youtubeChip);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Timeout: YouTube source type chip not found after ${timeout}ms.`));
            }
        }, 250);
    });
}

async function typeIntoInput(inputElement, text) {
    if (stopAutomationSignal) throw new Error("Automation stopped by user during typeIntoInput.");
    inputElement.focus();
    inputElement.value = text;
    inputElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
}

function delay(ms) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(resolve, ms);
        const intervalId = setInterval(() => {
            if (stopAutomationSignal) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                reject(new Error("Automation stopped by user during delay."));
            }
        }, 100);
        setTimeout(() => clearInterval(intervalId), ms);
    });
}

// --- Main Logic ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ADD_VIDEOS_TO_NOTEBOOKLM") {
        console.log("Received videos to add:", message.videos);
        stopAutomationSignal = false;
        currentResponseCallback = sendResponse;

        if (!message.videos || message.videos.length === 0) {
            currentResponseCallback({ status: "error", data: "No videos provided to add." });
            return false;
        }

        addVideosToNotebookLM(message.videos)
            .then(() => {
                if (!stopAutomationSignal) {
                    currentResponseCallback({ status: "complete", data: "All videos processed." });
                }
            })
            .catch(err => {
                console.error("Error during batch video processing in content script:", err);
                if (!err.message.includes("Automation stopped by user")) {
                    try {
                        currentResponseCallback({ status: "error", data: `Content script error: ${err.message}` });
                    } catch (e) {
                        console.warn("Could not send error response back to popup:", e);
                    }
                }
            });
        return true;
    } else if (message.action === "STOP_NOTEBOOKLM_AUTOMATION") {
        console.log("Received STOP_NOTEBOOKLM_AUTOMATION signal.");
        stopAutomationSignal = true;
        if (currentResponseCallback) {
            try {
                currentResponseCallback({ status: "stopped", data: "Automation stop signal received by content script." });
            } catch (e) {
                console.warn("Could not send 'stopped' confirmation via original callback:", e);
            }
            currentResponseCallback = null;
        }
        sendResponse({ status: "acknowledged_stop" });
        return false;
    }
    return false;
});

async function addVideosToNotebookLM(videos) {
    if (currentResponseCallback) {
        try {
            currentResponseCallback({ status: "progress", data: `Starting to add ${videos.length} videos...`, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
        } catch(e) { console.warn("Could not send initial progress."); }
    } else {
        chrome.runtime.sendMessage({ status: "progress", data: `Starting to add ${videos.length} videos...`, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
    }

    await delay(500);

    for (let i = 0; i < videos.length; i++) {
        if (stopAutomationSignal) {
            console.log("Automation stopping due to signal.");
            chrome.runtime.sendMessage({ status: "stopped", data: "Automation stopped by user.", type: "NOTEBOOKLM_AUTOMATION_STATUS" });
            return;
        }

        const video = videos[i];
        const progressMessage = `Adding video ${i + 1} of ${videos.length}: "${video.title.substring(0, 30)}..."`;
        console.log(progressMessage);
        chrome.runtime.sendMessage({ status: "progress", data: progressMessage, type: "NOTEBOOKLM_AUTOMATION_STATUS", video_index_processing: i });

        try {
            // 1. Click the main "+ Add" source button
            const addSourceBtn = await waitForElement(NOTEBOOKLM_SELECTORS.addSourceButton, document, 7000);
            addSourceBtn.click();
            await delay(500);

            // 2. In the modal, find and click the "YouTube" chip
            const dialogContainer = await waitForElement('mat-dialog-container', document, 5000);
            const youtubeButtonInModal = await findYoutubeChip(dialogContainer, 5000);
            youtubeButtonInModal.click();
            await delay(500);

            // 3. Find the YouTube link input field and paste the link
            const activeDialogForInput = document.querySelector('mat-dialog-container:not([hidden])') || dialogContainer;
            const youtubeLinkInput = await waitForElement(NOTEBOOKLM_SELECTORS.youtubeLinkInput, activeDialogForInput, 5000);
            await typeIntoInput(youtubeLinkInput, video.link);
            await delay(200);

            // 4. Click the "Insert" button
            const activeDialogForInsert = document.querySelector('mat-dialog-container:not([hidden])') || dialogContainer;
            const insertButton = await waitForElement(NOTEBOOKLM_SELECTORS.submitButton, activeDialogForInsert, 5000);
            insertButton.click();

            // 5. Wait for insert process to complete
            await waitForElementToDisappear(NOTEBOOKLM_SELECTORS.youtubeLinkInput, activeDialogForInsert, 15000);
            console.log(`Video "${video.title}" likely added.`);

            chrome.runtime.sendMessage({
                status: "video_success",
                data: `Successfully added: "${video.title.substring(0, 30)}..."`,
                type: "NOTEBOOKLM_AUTOMATION_STATUS",
                video_index_added: i,
                video_link_added: video.link
            });
            await delay(1500 + Math.random() * 500);

        } catch (error) {
            if (stopAutomationSignal || (error.message && error.message.includes("Automation stopped by user"))) {
                console.log("Process caught stop signal during video addition.");
                chrome.runtime.sendMessage({ status: "stopped", data: "Automation stopped during video processing.", type: "NOTEBOOKLM_AUTOMATION_STATUS" });
                return;
            }
            const errorMessage = `Failed to add "${video.title}": ${error.message}. Stopping.`;
            console.error(errorMessage, error);
            chrome.runtime.sendMessage({ status: "error", data: errorMessage, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
            return;
        }
    }
    if (!stopAutomationSignal) {
         console.log("All videos processed successfully (or attempted).");
    }
}