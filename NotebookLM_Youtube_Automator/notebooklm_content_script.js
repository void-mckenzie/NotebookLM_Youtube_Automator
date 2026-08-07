// notebooklm_content_script.js

console.log("NotebookLM Content Script Loaded (v2 - Language Agnostic)");

const NOTEBOOKLM_SELECTORS = {
    addSourceButton: 'button.add-source-button',
    // Primary: new textarea with formcontrolname="urls"
    youtubeLinkInput: 'textarea[formcontrolname="urls"]',
    // Fallback: old input with formcontrolname="newUrl"
    youtubeLinkInputFallback: 'input[formcontrolname="newUrl"]',
    // Primary selector using visual attributes
    submitButton: 'button[mat-flat-button][color="primary"]',
    // Fallback using jslog tracking ID
    submitButtonFallback: 'button[jslog="279307"]',
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
 * UPDATED HELPER: Finds the YouTube/Websites source button by looking for the unique
 * youtube-icon class or the video_youtube icon text, then finding its clickable parent button.
 * @param {Element} searchContext - The element to search within (e.g., the dialog).
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<Element>} Resolves with the clickable button element.
 */
function findYoutubeChip(searchContext, timeout = 5000) {
    console.log("Searching for YouTube/Websites button (v5 method - updated UI)...");
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const interval = setInterval(() => {
            if (stopAutomationSignal) {
                clearInterval(interval);
                reject(new Error("Automation stopped by user during findYoutubeChip."));
                return;
            }

            let youtubeButton = null;

            // Method 1: Look for the mat-icon with the 'youtube-icon' class (new UI)
            const youtubeIcon = searchContext.querySelector('mat-icon.youtube-icon');
            if (youtubeIcon) {
                const button = youtubeIcon.closest('button.drop-zone-icon-button');
                if (button && button.offsetParent !== null) {
                    youtubeButton = button;
                }
            }

            // Method 2: Fallback to looking for video_youtube text content (old UI compatibility)
            if (!youtubeButton) {
                const icons = searchContext.querySelectorAll('mat-icon');
                for (const icon of icons) {
                    if ((icon.textContent || "").trim() === 'video_youtube') {
                        // Try new UI button first
                        let parent = icon.closest('button.drop-zone-icon-button');
                        if (parent && parent.offsetParent !== null) {
                            youtubeButton = parent;
                            break;
                        }
                        // Fallback to old UI mat-chip
                        parent = icon.closest('mat-chip[tabindex="0"]');
                        if (parent && parent.offsetParent !== null) {
                            youtubeButton = parent;
                            break;
                        }
                    }
                }
            }

            if (youtubeButton) {
                clearInterval(interval);
                console.log("Found YouTube/Websites button:", youtubeButton);
                resolve(youtubeButton);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                reject(new Error(`Timeout: YouTube/Websites source button not found after ${timeout}ms.`));
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
    const BATCH_SIZE = 15;

    const totalBatches = Math.ceil(videos.length / BATCH_SIZE);

    if (currentResponseCallback) {
        try {
            currentResponseCallback({ status: "progress", data: `Starting to add ${videos.length} videos in ${totalBatches} batch(es) of up to ${BATCH_SIZE}...`, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
        } catch (e) { console.warn("Could not send initial progress."); }
    } else {
        chrome.runtime.sendMessage({ status: "progress", data: `Starting to add ${videos.length} videos in ${totalBatches} batch(es) of up to ${BATCH_SIZE}...`, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
    }

    await delay(500);

    for (let batchStart = 0; batchStart < videos.length; batchStart += BATCH_SIZE) {
        if (stopAutomationSignal) {
            console.log("Automation stopping due to signal.");
            chrome.runtime.sendMessage({ status: "stopped", data: "Automation stopped by user.", type: "NOTEBOOKLM_AUTOMATION_STATUS" });
            return;
        }

        const batch = videos.slice(batchStart, batchStart + BATCH_SIZE);
        const batchNumber = Math.floor(batchStart / BATCH_SIZE) + 1;
        const batchLinks = batch.map(v => v.link);
        const progressMessage = `Adding batch ${batchNumber} of ${totalBatches}: videos ${batchStart + 1}-${batchStart + batch.length} of ${videos.length}...`;
        console.log(progressMessage);
        chrome.runtime.sendMessage({ status: "progress", data: progressMessage, type: "NOTEBOOKLM_AUTOMATION_STATUS" });

        try {
            // 1. Click the main "+ Add sources" button
            const addSourceBtn = await waitForElement(NOTEBOOKLM_SELECTORS.addSourceButton, document, 7000);
            addSourceBtn.click();
            await delay(500);

            // 2. In the modal, find and click the "YouTube/Websites" chip
            const dialogContainer = await waitForElement('mat-dialog-container', document, 5000);
            const youtubeButtonInModal = await findYoutubeChip(dialogContainer, 5000);
            youtubeButtonInModal.click();
            await delay(500);

            // 3. Type all URLs in this batch, newline-separated (textarea accepts multiple)
            const activeDialogForInput = document.querySelector('mat-dialog-container:not([hidden])') || dialogContainer;
            let youtubeLinkInput;
            try {
                youtubeLinkInput = await waitForElement(NOTEBOOKLM_SELECTORS.youtubeLinkInput, activeDialogForInput, 3000);
            } catch (e) {
                console.log("Primary input selector failed, trying fallback...");
                youtubeLinkInput = await waitForElement(NOTEBOOKLM_SELECTORS.youtubeLinkInputFallback, activeDialogForInput, 3000);
            }
            await typeIntoInput(youtubeLinkInput, batchLinks.join("\n"));
            await delay(300);

            // 4. Click the "Insert" button (try primary selector, then fallback)
            const activeDialogForInsert = document.querySelector('mat-dialog-container:not([hidden])') || dialogContainer;
            let insertButton;
            try {
                insertButton = await waitForElement(NOTEBOOKLM_SELECTORS.submitButton, activeDialogForInsert, 3000);
            } catch (e) {
                console.log("Primary Insert selector failed, trying fallback...");
                insertButton = await waitForElement(NOTEBOOKLM_SELECTORS.submitButtonFallback, activeDialogForInsert, 3000);
            }
            insertButton.click();

            // 5. Wait for the textarea to disappear (Insert processed). Larger batches take longer.
            await waitForElementToDisappear(NOTEBOOKLM_SELECTORS.youtubeLinkInput, activeDialogForInsert, 60000);
            console.log(`Batch ${batchNumber} of ${totalBatches} submitted (${batch.length} URLs).`);

            chrome.runtime.sendMessage({
                status: "video_success_batch",
                data: `Batch ${batchNumber} of ${totalBatches} added (${batch.length} videos).`,
                type: "NOTEBOOKLM_AUTOMATION_STATUS",
                video_links_added: batchLinks
            });
            await delay(1500 + Math.random() * 500);

        } catch (error) {
            if (stopAutomationSignal || (error.message && error.message.includes("Automation stopped by user"))) {
                console.log("Process caught stop signal during batch submission.");
                chrome.runtime.sendMessage({ status: "stopped", data: "Automation stopped during batch submission.", type: "NOTEBOOKLM_AUTOMATION_STATUS" });
                return;
            }
            const errorMessage = `Failed to submit batch ${batchNumber} (${batch.length} URLs starting at index ${batchStart}): ${error.message}. Stopping. Failed links: ${batchLinks.join(", ")}`;
            console.error(errorMessage, error);
            chrome.runtime.sendMessage({
                status: "error",
                data: `Batch ${batchNumber} failed: ${error.message}`,
                type: "NOTEBOOKLM_AUTOMATION_STATUS",
                failed_links: batchLinks
            });
            return;
        }
    }
    if (!stopAutomationSignal) {
        console.log("All batches processed successfully (or attempted).");
    }
}