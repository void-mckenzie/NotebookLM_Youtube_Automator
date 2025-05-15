// notebooklm_content_script.js

console.log("NotebookLM Content Script Loaded");

const NOTEBOOKLM_SELECTORS = {
    addSourceButton: 'button[aria-label="Add source"]',
    youtubeLinkInput: 'input[formcontrolname="newUrl"]',
};

let stopAutomationSignal = false; // Flag to signal stopping the process
let currentResponseCallback = null; // To store sendResponse for ongoing communication

// --- Helper Functions (waitForElement, waitForElementToDisappear, findClickableElementByText, typeIntoInput, delay) ---
// ... (Keep existing helper functions as they are) ...
/**
 * Waits for an element to exist in the DOM and be visible.
 * @param {string} selector - The CSS selector for the element.
 * @param {Element} parent - The parent element to search within (defaults to document).
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<Element>} Resolves with the element, or rejects on timeout.
 */
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

/**
 * Waits for an element to disappear from the DOM or become hidden.
 * @param {string} selector - The CSS selector for the element.
 * @param {Element} parent - The parent element to search within (defaults to document).
 * @param {number} timeout - Maximum time to wait in milliseconds.
 * @returns {Promise<void>} Resolves when the element is gone/hidden, or rejects on timeout.
 */
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
 * Finds a clickable element (button, div[role="button"], mat-chip, specific spans) containing specific text.
 * This is more robust for dynamic UIs where IDs/classes might change.
 * @param {string[]} targetNodeNames - Array of node names like ['BUTTON', 'DIV', 'MAT-CHIP'].
 * @param {string} textToFind - The text content to search for.
 * @param {Element} searchContext - Element to search within (e.g., a modal). Defaults to document.
 * @returns {Promise<Element|null>} The found element or null.
 */
async function findClickableElementByText(targetNodeNames, textToFind, searchContext = document, timeout = 5000) {
    console.log(`Searching for clickable element with text: "${textToFind}" within`, searchContext);
    const startTime = Date.now();
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            if (stopAutomationSignal) {
                clearInterval(interval);
                reject(new Error("Automation stopped by user during findClickableElementByText."));
                return;
            }
            let foundElement = null;
            const candidates = searchContext.querySelectorAll(targetNodeNames.join(', '));

            for (const candidate of candidates) {
                const textContent = (candidate.textContent || "").trim();
                const ariaLabel = candidate.getAttribute('aria-label');

                if (candidate.offsetParent === null || candidate.closest('[hidden]') || getComputedStyle(candidate).display === 'none' || getComputedStyle(candidate).visibility === 'hidden') {
                    continue;
                }

                if (textContent.includes(textToFind) || (ariaLabel && ariaLabel.includes(textToFind))) {
                    if (targetNodeNames.includes(candidate.tagName.toLowerCase()) || candidate.matches('[role="button"], [mat-button], [mat-stroked-button], [mat-flat-button], [mat-icon-button], [mat-fab], [mat-mini-fab], .mdc-button, .mat-mdc-chip-action-label')) {
                        foundElement = candidate;
                        break;
                    }
                }
            }
            if (!foundElement) {
                const chipLabels = searchContext.querySelectorAll('span.mdc-evolution-chip__text-label');
                for (const chipLabel of chipLabels) {
                    const innerSpan = chipLabel.querySelector('span');
                    if (innerSpan && (innerSpan.textContent || "").trim() === textToFind && chipLabel.offsetParent !== null) {
                        foundElement = chipLabel;
                        break;
                    }
                }
            }

            if (foundElement) {
                clearInterval(interval);
                console.log(`Found element for "${textToFind}":`, foundElement);
                resolve(foundElement);
            } else if (Date.now() - startTime > timeout) {
                clearInterval(interval);
                console.warn(`Timeout or not found: Clickable element with text "${textToFind}"`);
                reject(new Error(`Timeout or not found: Clickable element with text "${textToFind}" after ${timeout}ms.`));
            }
        }, 250);
    });
}


/**
 * Types text into an input field and dispatches an 'input' event
 * for frameworks like Angular to recognize the change.
 * @param {HTMLInputElement} inputElement - The input element.
 * @param {string} text - The text to type.
 */
async function typeIntoInput(inputElement, text) {
    if (stopAutomationSignal) throw new Error("Automation stopped by user during typeIntoInput.");
    inputElement.focus();
    inputElement.value = text;
    inputElement.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    inputElement.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 50));
}

/**
 * Introduces a delay.
 * @param {number} ms - Delay in milliseconds.
 */
function delay(ms) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(resolve, ms);
        // Check for stop signal periodically during delay
        const intervalId = setInterval(() => {
            if (stopAutomationSignal) {
                clearTimeout(timeoutId);
                clearInterval(intervalId);
                reject(new Error("Automation stopped by user during delay."));
            }
        }, 100); // Check every 100ms
        // Clear interval when delay completes normally
        setTimeout(() => clearInterval(intervalId), ms);
    });
}

// --- Main Logic ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "ADD_VIDEOS_TO_NOTEBOOKLM") {
        console.log("Received videos to add:", message.videos);
        stopAutomationSignal = false; // Reset stop signal for a new run
        currentResponseCallback = sendResponse; // Store for ongoing updates

        if (!message.videos || message.videos.length === 0) {
            currentResponseCallback({ status: "error", data: "No videos provided to add." });
            return false; // No async response needed here
        }

        addVideosToNotebookLM(message.videos)
            .then(() => {
                console.log("Finished processing all videos from content script.");
                if (!stopAutomationSignal) { // Only send complete if not stopped
                    currentResponseCallback({ status: "complete", data: "All videos processed." });
                }
            })
            .catch(err => {
                console.error("Error during batch video processing in content script:", err);
                // If error is due to stopping, it's already handled or will be
                if (!err.message.includes("Automation stopped by user")) {
                    try {
                        currentResponseCallback({ status: "error", data: `Content script error: ${err.message}` });
                    } catch (e) {
                        console.warn("Could not send error response back to popup (already responded or channel closed):", e);
                    }
                }
            });
        return true; // Indicates that currentResponseCallback will be used asynchronously.
    } else if (message.action === "STOP_NOTEBOOKLM_AUTOMATION") {
        console.log("Received STOP_NOTEBOOKLM_AUTOMATION signal.");
        stopAutomationSignal = true;
        if (currentResponseCallback) {
            try {
                currentResponseCallback({ status: "stopped", data: "Automation stop signal received by content script." });
            } catch (e) {
                // This might happen if the original ADD_VIDEOS_TO_NOTEBOOKLM response channel was already used up
                // or closed. The main effect is setting the flag.
                console.warn("Could not send 'stopped' confirmation via original callback:", e);
            }
            currentResponseCallback = null; // Clear it as we've "responded" to the stop
        }
        // Optionally, send a new message to popup if the above fails, but popup also updates UI optimistically.
        sendResponse({ status: "acknowledged_stop" });
        return false;
    }
    return false; // For any other messages
});

async function addVideosToNotebookLM(videos) {
    // Initial message to popup
    if (currentResponseCallback) {
        try {
            currentResponseCallback({ status: "progress", data: `Starting to add ${videos.length} videos...`, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
        } catch(e) { console.warn("Could not send initial progress, popup might have closed or callback used."); }
    } else { // Fallback if initial callback is tricky
        chrome.runtime.sendMessage({ status: "progress", data: `Starting to add ${videos.length} videos...`, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
    }


    await delay(500);

    for (let i = 0; i < videos.length; i++) {
        if (stopAutomationSignal) {
            console.log("Automation stopping due to signal.");
            chrome.runtime.sendMessage({ status: "stopped", data: "Automation stopped by user.", type: "NOTEBOOKLM_AUTOMATION_STATUS" });
            return; // Exit the loop and function
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

            // 2. In the modal, click the "YouTube" button/chip
            const dialogContainer = await waitForElement('mat-dialog-container', document, 5000);
            const youtubeButtonInModal = await findClickableElementByText(
                ['button', 'div[role="button"]', 'mat-chip', 'span.mdc-evolution-chip__text-label'],
                'YouTube', dialogContainer, 5000
            );
            youtubeButtonInModal.click();
            await delay(500);

            // 3. Find the YouTube link input field and paste the link
            const activeDialogForInput = document.querySelector('mat-dialog-container:not([hidden])') || dialogContainer;
            const youtubeLinkInput = await waitForElement(NOTEBOOKLM_SELECTORS.youtubeLinkInput, activeDialogForInput, 5000);
            await typeIntoInput(youtubeLinkInput, video.link);
            await delay(200);

            // 4. Click the "Insert" button
            const activeDialogForInsert = document.querySelector('mat-dialog-container:not([hidden])') || dialogContainer;
            const insertButton = await findClickableElementByText(
                ['button', 'span'], 'Insert', activeDialogForInsert, 5000
            );
            insertButton.click();

            // 5. Wait for insert process
            await waitForElementToDisappear(NOTEBOOKLM_SELECTORS.youtubeLinkInput, activeDialogForInsert, 15000); // Increased timeout for processing
            console.log(`Video "${video.title}" likely added.`);

            chrome.runtime.sendMessage({
                status: "video_success",
                data: `Successfully added: "${video.title.substring(0, 30)}..."`,
                type: "NOTEBOOKLM_AUTOMATION_STATUS",
                video_index_added: i, // Send back the original index
                video_link_added: video.link // And/or the link for more robust matching
            });
            await delay(1500 + Math.random() * 500);

        } catch (error) {
            if (stopAutomationSignal || (error.message && error.message.includes("Automation stopped by user"))) {
                console.log("Process caught stop signal during video addition.");
                chrome.runtime.sendMessage({ status: "stopped", data: "Automation stopped during video processing.", type: "NOTEBOOKLM_AUTOMATION_STATUS" });
                return; // Exit
            }
            const errorMessage = `Failed to add "${video.title}": ${error.message}. Stopping.`;
            console.error(errorMessage, error);
            chrome.runtime.sendMessage({ status: "error", data: errorMessage, type: "NOTEBOOKLM_AUTOMATION_STATUS" });
            return; // Stop on first error
        }
    }
    // If loop completes without being stopped
    if (!stopAutomationSignal) {
         console.log("All videos processed successfully (or attempted).");
         // The 'complete' message is now sent by the .then() block of addVideosToNotebookLM caller
         // if currentResponseCallback is used, or needs a dedicated send here if not.
         // For consistency, let the caller's .then() handle the "complete" status.
    }
}