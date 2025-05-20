// Import necessary Firebase services and functions from firebase-init.js
import { auth, db, signInAnonymously } from './firebase-init.js';
import { collection, addDoc, Timestamp, getDocs, query, orderBy, doc, getDoc, updateDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js';
import { calculateTreeWateringStatus, TREE_WATERING_STATUSES } from './treeUtils.js'; // Added import
// Note: Importing directly from an HTML file like this is unconventional.
// A better practice would be to have a firebaseInit.js that exports these, 
// and both index.html and app.js import from there.
// However, for simplicity with the current setup, we'll try this.
// If this doesn't work, we'll create a separate firebaseInit.js

// App version information
const APP_VERSION = {
    number: '1.0.2',
    name: 'Grove Guardian',
    lastUpdated: '2025-05-14'
};
window.APP_VERSION = APP_VERSION; // Make available globally

// DOM Elements
const treeListDiv = document.getElementById('tree-list');
const caseyTreesAlertDetails = document.getElementById('casey-trees-alert-details');
let currentWateringRecommendation = "Optional"; // Default, will be updated from Firestore

// Helper function to ensure minimum loading time
async function ensureMinLoadingTime(startTime, minDuration = 1000) {
    const elapsedTime = Date.now() - startTime;
    if (elapsedTime < minDuration) {
        await new Promise(resolve => setTimeout(resolve, minDuration - elapsedTime));
    }
}

// Test Firebase connection immediately
try {
    const testDocRef = doc(db, 'site_config', 'test');
    await getDoc(testDocRef);
} catch (error) {
    console.error('Error connecting to Firestore:', error);
}

// Function to initialize Firestore with default data if needed
async function initializeFirestoreIfNeeded() {
    const alertDocRef = doc(db, 'site_config', 'watering_alert');
    const alertDoc = await getDoc(alertDocRef);
    
    if (!alertDoc.exists()) {
        const defaultAlert = {
            status: "Optional",
            details: "Initial status. Will be updated with live data from Casey Trees.",
            lastUpdated: Timestamp.now(),
            source: 'default'
        };
        
        try {
            await setDoc(alertDocRef, defaultAlert);
            return defaultAlert;
        } catch (error) {
            console.error('Error initializing Firestore:', error);
            throw error;
        }
    }
    
    return alertDoc.data();
}

// Function to sign in a user anonymously
const anonCreateUser = async () => {
    try {
        const userCredential = await signInAnonymously(auth);
        const user = userCredential.user;
        
        // Initialize Firestore if needed
        const initialData = await initializeFirestoreIfNeeded();
        
        // Display the initial/existing data
        await displayWateringAlert(initialData);
        
        // Then try to get fresh data
        await getAndUpdateWateringAlert();
        
        // Load the trees based on the alert status
        await loadTrees();
    } catch (error) {
        console.error("Error in initialization:", error);
        if (treeListDiv) treeListDiv.innerHTML = '<p>Error initializing application. Please try refreshing the page.</p>';
    }
};

// Function to get watering alert with timeout
async function getAndUpdateWateringAlert() {
    try {
        if (!db) {
            throw new Error('Firestore database not initialized!');
        }

        // First try to get existing alert from Firestore
        const alertDocRef = doc(db, 'site_config', 'watering_alert');
        
        // Create a promise that resolves after 10 seconds
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => resolve('timeout'), 10000);
        });

        // Race between Firestore fetch and timeout
        const alertDocPromise = getDoc(alertDocRef);
        const result = await Promise.race([alertDocPromise, timeoutPromise]);
        
        let shouldFetchFromCaseyTrees = true;
        
        if (result === 'timeout') {
            console.warn('Firestore taking longer than expected...');
            // Continue waiting for the actual result
            const alertDoc = await alertDocPromise;
            if (alertDoc.exists()) {
                const data = alertDoc.data();
                await displayWateringAlert(data);
                shouldFetchFromCaseyTrees = isDataStale(data.lastUpdated);
            }
        } else if (result.exists()) {
            const data = result.data();
            await displayWateringAlert(data);
            shouldFetchFromCaseyTrees = isDataStale(data.lastUpdated);
        }

        // If data is stale (>24h old) or doesn't exist, fetch fresh data from Casey Trees
        if (shouldFetchFromCaseyTrees) {
            try {
                await fetchAndStoreCaseyTreesAlert();
            } catch (fetchError) {
                console.error("Error fetching from Casey Trees:", fetchError);
                // Keep displaying the current data, just log the error
            }
        }
        
    } catch (error) {
        console.error("Error in getAndUpdateWateringAlert:", error);
        await displayWateringAlert({
            status: "Optional",
            details: "Unable to fetch watering status. Please check trees for signs of needing water.",
            lastUpdated: Timestamp.now(),
            source: 'default'
        });
    }
}

// Helper function to check if data is stale (older than 24 hours)
function isDataStale(timestamp) {
    if (!timestamp) return true;
    
    const lastUpdated = timestamp.toDate();
    const oneDayAgo = new Date();
    oneDayAgo.setHours(oneDayAgo.getHours() - 24);
    
    return lastUpdated < oneDayAgo;
}

// Function to fetch and parse Casey Trees alert
async function fetchAndStoreCaseyTreesAlert() {
    
    const response = await fetch('https://us-central1-community-tree-watering.cloudfunctions.net/caseyTreesProxy');
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();    
    const parser = new DOMParser();
    const parsedHtmlDoc = parser.parseFromString(html, 'text/html');
    
    // Try to find the watering alert status
    const alertText = parsedHtmlDoc.querySelector('.watering-alert, .alert-status, [class*="watering"]')?.textContent || '';
    
    let status = null;
    let details = "";
    
    // Look for the status in the alert text
    if (alertText.toLowerCase().includes('must water')) {
        status = 'Must Water';
    } else if (alertText.toLowerCase().includes('optional')) {
        status = 'Optional';
    } else if (alertText.toLowerCase().includes("don't water") || alertText.toLowerCase().includes('do not water')) {
        status = "Don't Water";
    }
    
    // If we didn't find the status in the alert text, try the whole page
    if (!status) {
        const fullText = parsedHtmlDoc.body.textContent;
        const statusMatch = fullText.match(/Weekly Watering Alert\s*\|\s*(Must Water|Optional|Don't Water)/i);
        if (statusMatch) {
            status = statusMatch[1];
            // Try to get the details from the following text
            const afterStatus = fullText.substring(fullText.indexOf(statusMatch[0]) + statusMatch[0].length);
            const nextPeriod = afterStatus.indexOf('.');
            if (nextPeriod > 0) {
                details = afterStatus.substring(0, nextPeriod).trim();
            }
        }
    }
    
    if (!status) {
        throw new Error("Could not find watering status on Casey Trees website");
    }
    
    // If we don't have details, get them from the default text
    if (!details) {
        details = getDefaultDetails(status);
    }
    
    const alertData = {
        status,
        details,
        lastUpdated: Timestamp.now(),
        source: 'https://caseytrees.org/water/'
    };
    
    
    try {
        const alertDocRef = doc(db, 'site_config', 'watering_alert');
        await setDoc(alertDocRef, alertData);
        await displayWateringAlert(alertData);
    } catch (error) {
        console.error("Error storing in Firestore:", error);
        throw error;
    }
}

// Helper function to get default details based on status
function getDefaultDetails(status) {
    switch (status) {
        case "Must Water":
            return "Very little observed or forecasted rainfall this week. Young trees must be watered.";
        case "Optional":
            return "Trees may need water, depending on the forecast. Check trees for signs (wilting leaves and/or dry soil) and water as needed.";
        case "Don't Water":
            return "Recent or predicted rainfall exceeding 1.5 inches this week. Trees have enough water.";
        default:
            return "Check trees for signs of needing water and water as needed.";
    }
}

// Function to display the watering alert
async function displayWateringAlert(alertData) {
    await ensureMinLoadingTime(window.loadStartTime);
    
    currentWateringRecommendation = alertData.status;
    
    const wateringRecommendationDiv = document.getElementById('watering-recommendation');
    if (!wateringRecommendationDiv) {
        return;
    }
    
    const loadingContainer = wateringRecommendationDiv.querySelector('.loading-container');
    if (loadingContainer) {
        loadingContainer.classList.remove('active');
    }
    
    const titleElement = wateringRecommendationDiv.querySelector('h2');
    if (titleElement) {
        titleElement.style.display = 'block';
    }
    
    const statusElement = document.getElementById('casey-trees-alert-status');
    if (statusElement) {
        statusElement.style.display = 'block';
        statusElement.textContent = alertData.status;
    }
    
    const detailsElement = document.getElementById('casey-trees-alert-details');
    const metaDataElement = document.getElementById('alert-meta-data');

    if (detailsElement) {
        const effectiveDateText = `Effective: ${getCurrentWeekDateRange()}`;
        detailsElement.textContent = effectiveDateText;
    }

    if (metaDataElement) {
        let metaHTML = 'Source: <a href="https://caseytrees.org/water/" target="_blank" rel="noopener noreferrer">Casey Trees</a>';
        const lastUpdated = alertData.lastUpdated?.toDate();
        if (lastUpdated) {
            metaHTML += ` <span class="meta-separator">|</span> Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        }
        metaDataElement.innerHTML = metaHTML;
        // Styling is primarily handled by .alert-meta class in CSS
    }
}

// --- Load and Display Thirsty Trees Only ---
async function loadTrees() {
    const startTime = Date.now();
    
    if (!db) {
        if (treeListDiv) treeListDiv.innerHTML = '<p>Error: Database connection not available.</p>';
        return;
    }
    if (!treeListDiv) {
        return;
    }

    try {
        const treesCollection = collection(db, 'trees');
        const q = query(treesCollection, orderBy("lastWateredDate", "asc"));
        const querySnapshot = await getDocs(q);

        // Ensure minimum loading time
        await ensureMinLoadingTime(startTime);

        // Hide loading animation
        const loadingContainer = document.querySelector('#tree-list .loading-container');
        if (loadingContainer) {
            loadingContainer.classList.remove('active');
        }

        if (querySnapshot.empty) {
            treeListDiv.innerHTML = '<h2>Tree Status</h2><p>No trees found in the database.</p>';
            return;
        }

        let myGroveHTML = '';
        let thirstyTreesHTML = '<div class="list-section-header"><h2>Thirsty Trees <span class="thirsty-emoji">😫</span></h2></div><ul class="thirsty-tree-list">';
        let waterSoonTreesHTML = '<div class="list-section-header"><h2>Needs Watering Soon <span class="water-soon-emoji">💧</span></h2></div><ul class="water-soon-tree-list">';
        
        let thirstyTreeCount = 0;
        let waterSoonTreeCount = 0;
        const processedForMyGrove = new Set();

        // Helper to get consistent CSS class prefix from status strings
        const getStatusCssClass = (statusStr) => {
            if (!statusStr) return '';
            return statusStr.toLowerCase().replace(/_/g, '-'); // Handles WATER_SOON -> water-soon
        };

        // New helper function to centralize display logic for tree statuses
        function getTreeDisplayDetails(statusConstant) {
            let rawMessage = "";
            // cssClassKey will be like "thirsty", "water-soon", derived from statusConstant
            let cssClassKey = ""; 

            switch (statusConstant) {
                case TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION:
                    rawMessage = "😫 New tree, needs water!";
                    // Visually treat as thirsty, so use THIRSTY's CSS key
                    cssClassKey = getStatusCssClass(TREE_WATERING_STATUSES.THIRSTY);
                    break;
                case TREE_WATERING_STATUSES.THIRSTY:
                    rawMessage = "😫 Needs water now!";
                    cssClassKey = getStatusCssClass(TREE_WATERING_STATUSES.THIRSTY);
                    break;
                case TREE_WATERING_STATUSES.WATER_SOON:
                    rawMessage = "💧 Water within 3 days"; // User's preference (no period)
                    cssClassKey = getStatusCssClass(TREE_WATERING_STATUSES.WATER_SOON);
                    break;
                case TREE_WATERING_STATUSES.NEVER_WATERED_OKAY:
                    rawMessage = "New tree, conditions good.";
                    cssClassKey = getStatusCssClass(TREE_WATERING_STATUSES.OKAY);
                    break;
                case TREE_WATERING_STATUSES.OKAY:
                    rawMessage = ""; // No specific message for "Okay"
                    cssClassKey = getStatusCssClass(TREE_WATERING_STATUSES.OKAY);
                    break;
                case TREE_WATERING_STATUSES.DONT_WATER:
                    rawMessage = ""; // No specific message for "Don't Water"
                    // Visually treat as Okay for general styling if needed
                    cssClassKey = getStatusCssClass(TREE_WATERING_STATUSES.OKAY); 
                    break;
                default:
                    // Fallback for any unknown status
                    rawMessage = "";
                    cssClassKey = "unknown";
            }
            // Return the original statusConstant as well, as it's useful for logic
            return { rawMessage, cssClassKey, statusConstant };
        }

        // Renamed function: Determines the watering status of a tree
        const getTreeWateringStatus = (tree) => {
            // Delegate to the centralized utility function
            return calculateTreeWateringStatus(tree, 'lastWateredDate', currentWateringRecommendation);
        };

        // --- MY GROVE SECTION ---
        const myGroveTreeIds = getMyGrove(); // Renamed for clarity
        if (myGroveTreeIds.length > 0) {
            myGroveHTML = `<div class="grove-header">
                <div class="title-row">
                    <span class="material-icons">park</span>
                    <h2>My Grove</h2>
                    <span class="material-icons">park</span>
                </div>
            </div><ul class="grove-tree-list">`;
            
            const treeDataMap = new Map();
            querySnapshot.forEach(doc => {
                treeDataMap.set(doc.id, { ...doc.data(), id: doc.id });
            });
            
            myGroveTreeIds.forEach(treeId => {
                const tree = treeDataMap.get(treeId);
                if (tree) {
                    processedForMyGrove.add(treeId); // Mark as processed for My Grove
                    const wateringStatusResult = getTreeWateringStatus(tree);
                    const lastWateredDateStr = tree.lastWateredDate ? tree.lastWateredDate.toDate().toLocaleDateString() : 'Never';
                    
                    const displayDetails = getTreeDisplayDetails(wateringStatusResult); // Use new helper
                    
                    let statusMessageHTML = '';
                    if (displayDetails.rawMessage) {
                        statusMessageHTML = `<span class="tree-status-message ${displayDetails.cssClassKey}">${displayDetails.rawMessage}</span>`;
                    }

                    let itemClass = 'grove'; 
                    // Determine if an alert class should be added based on the status
                    switch (displayDetails.statusConstant) {
                        case TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION:
                        case TREE_WATERING_STATUSES.THIRSTY:
                        case TREE_WATERING_STATUSES.WATER_SOON:
                            itemClass += ` ${displayDetails.cssClassKey}-alert`;
                            break;
                        // Other statuses (OKAY, DONT_WATER, NEVER_WATERED_OKAY) don't get an alert class here
                    }

                    myGroveHTML += `
                        <li class="tree-item ${itemClass}" onclick="window.location.href='hoa_trees_map.html?treeId=${treeId}'">
                            <div class="tree-info">
                                <strong>
                                    ${tree.commonName || 'Unknown Tree'}
                                    <span class="material-icons favorite-icon-my-grove" style="color: #e53935; font-size: 18px; vertical-align: middle; margin-left: 6px;">
                                        favorite
                                    </span>
                                </strong>
                                ${statusMessageHTML}
                                <span class="last-watered">Last watered: ${lastWateredDateStr}</span>
                            </div>
                        </li>
                    `;
                }
            });
            myGroveHTML += '</ul>';
        }

        // --- GENERAL TREE LISTS (THIRSTY & WATER SOON) ---
        // Global "Don't Water" override for all lists below My Grove
        if (currentWateringRecommendation === "Don't Water") {
            let happyMessage = '<p class="happy-trees">All trees are happily hydrated thanks to the rain! 🌧️</p>';
            if (myGroveTreeIds.length > 0) { // If My Grove is shown, append message after it.
                treeListDiv.innerHTML = myGroveHTML + happyMessage;
            } else { // Otherwise, just show the message.
                treeListDiv.innerHTML = happyMessage;
            }
            return;
        }

        querySnapshot.forEach((doc) => {
            const tree = doc.data();
            const treeId = doc.id;
            
            // Skip if this tree was already displayed in My Grove
            if (processedForMyGrove.has(treeId)) {
                return;
            }
            
            const wateringStatusResult = getTreeWateringStatus(tree);
            const lastWateredDateStr = tree.lastWateredDate ? tree.lastWateredDate.toDate().toLocaleDateString() : 'Never';
            
            const displayDetails = getTreeDisplayDetails(wateringStatusResult); // Use new helper

            let listItemHTML = '';
            let listToAdd = null;

            // Determine which list the tree belongs to, based on its statusConstant
            switch (displayDetails.statusConstant) {
                case TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION:
                case TREE_WATERING_STATUSES.THIRSTY:
                    listToAdd = 'thirsty';
                    break;
                case TREE_WATERING_STATUSES.WATER_SOON:
                    listToAdd = 'waterSoon';
                    break;
                // For OKAY, DONT_WATER, NEVER_WATERED_OKAY, tree is not added to these general lists.
                default:
                    return; // Skip this tree if it doesn't fall into thirsty or waterSoon categories
            }

            if (listToAdd) {
                // displayDetails.rawMessage contains the text with emoji
                // displayDetails.cssClassKey is the base for class names (e.g., "thirsty", "water-soon")
                listItemHTML = `
                    <li class="tree-item ${displayDetails.cssClassKey}-alert" onclick="window.location.href='hoa_trees_map.html?treeId=${treeId}'">
                        <div class="tree-info">
                            <strong>${tree.commonName || 'Unknown Tree'}</strong>
                            <span class="tree-status-message ${displayDetails.cssClassKey}">${displayDetails.rawMessage}</span>
                            <span class="last-watered">Last watered: ${lastWateredDateStr}</span>
                        </div>
                    </li>
                `;
                if (listToAdd === 'thirsty') {
                    thirstyTreeCount++;
                    thirstyTreesHTML += listItemHTML;
                } else if (listToAdd === 'waterSoon') {
                    waterSoonTreeCount++;
                    waterSoonTreesHTML += listItemHTML;
                }
            }
        });

        thirstyTreesHTML += '</ul>';
        waterSoonTreesHTML += '</ul>';

        let finalHTML = myGroveHTML; // Start with My Grove content (if any)

        if (thirstyTreeCount > 0) {
            finalHTML += thirstyTreesHTML;
        }
        if (waterSoonTreeCount > 0) {
            finalHTML += waterSoonTreesHTML;
        }

        // Simplified logic for the "happy trees" message
        const hasMyGroveItems = myGroveTreeIds.length > 0;
        let hasAlertsInMyGrove = false;
        if (hasMyGroveItems) {
            hasAlertsInMyGrove = myGroveTreeIds.some(id => {
                const treeData = querySnapshot.docs.find(d => d.id === id)?.data();
                if (!treeData) return false;
                const status = getTreeWateringStatus(treeData);
                // Updated logic to use TREE_WATERING_STATUSES
                return status === TREE_WATERING_STATUSES.THIRSTY || 
                       status === TREE_WATERING_STATUSES.WATER_SOON || 
                       status === TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION;
            });
        }

        if (currentWateringRecommendation !== "Don't Water") {
            if (!hasMyGroveItems && thirstyTreeCount === 0 && waterSoonTreeCount === 0) {
                // No My Grove, no thirsty, no water soon -> happy message takes full space
                finalHTML = '<p class="happy-trees">All our trees are happy and well-watered! 🌳 ✨</p>';
            } else if (hasMyGroveItems && !hasAlertsInMyGrove && thirstyTreeCount === 0 && waterSoonTreeCount === 0) {
                // My Grove exists and has no alerts, and general lists are empty -> append happy message to My Grove
                finalHTML += '<p class="happy-trees">All our trees are happy and well-watered! 🌳 ✨</p>';
            } else if (finalHTML === '' || finalHTML === myGroveHTML && !hasAlertsInMyGrove && thirstyTreeCount === 0 && waterSoonTreeCount === 0 ){
                // Fallback in case MyGroveHTML was empty and the general lists also are empty.
                // Or if MyGroveHTML was present but had no alerts AND the general lists are empty.
                // This condition essentially ensures if no alerts are shown anywhere, the happy message appears.
                // This handles the case where myGroveTreeIds.length > 0 but all trees in it are 'OKAY' or 'DONT_WATER',
                // and the general lists are also empty.
                finalHTML = myGroveHTML; // Keep My Grove if it has non-alert items
                if (!hasAlertsInMyGrove && thirstyTreeCount === 0 && waterSoonTreeCount === 0) {
                    finalHTML += '<p class="happy-trees">All our trees are happy and well-watered! 🌳 ✨</p>';
                    if (!hasMyGroveItems) { // If My Grove was totally empty ensure only happy message
                        finalHTML = '<p class="happy-trees">All our trees are happy and well-watered! 🌳 ✨</p>';
                    }
                }
            }
        }
        // If currentWateringRecommendation IS "Don't Water", the happy message is already handled earlier.

        treeListDiv.innerHTML = finalHTML;

    } catch (error) {
        console.error("Error in loadTrees:", error);
        treeListDiv.innerHTML = '<h2>Tree Status</h2><p>Error loading tree statuses. Please try refreshing the page.</p>';
    }
}

// Add cookie management function
function getMyGrove() {
    const cookie = document.cookie.split('; ').find(row => row.startsWith('myGrove='));
    if (cookie) {
        try {
            return JSON.parse(cookie.split('=')[1]);
        } catch (e) {
            return [];
        }
    }
    return [];
}

// --- "I Watered This!" button functionality ---
window.updateLastWatered = async (treeId) => {
    if (!db) {
        console.error("Firestore (db) not initialized.");
        alert('Error: Database not connected.');
        return;
    }
    if (!auth.currentUser) {
        console.error("User not signed in.");
        alert('Error: You are not signed in.'); // Should not happen with anonymous auth
        return;
    }

    try {
        const treeRef = doc(db, "trees", treeId);
        
        // Update the lastWateredDate to the current time
        await updateDoc(treeRef, {
            lastWateredDate: Timestamp.now()
        });
                
        // Refresh the tree list to reflect the changes
        await loadTrees();
        
    } catch (error) {
        console.error(`Error updating lastWateredDate for tree: ${treeId}`, error);
        alert(`Error: Failed to update watering date. ${error.message}`);
    }
};

// Call the initial function to sign in and load data
window.loadStartTime = Date.now(); // Set initial load start time
anonCreateUser();

// --- Batch Import Function (Keep for console use if needed, or remove if done) ---
async function batchImportTreesFromConsole(treeDataArray) {
    if (!db) {
        console.error("Firestore database (db) is not initialized.");
        return;
    }
    if (!treeDataArray || treeDataArray.length === 0) {
        console.warn("No tree data provided to import.");
        return;
    }

    const treesCollectionRef = collection(db, 'trees'); // Corrected variable name
    let successfulImports = 0;
    let failedImports = 0;

    console.log(`Starting batch import of ${treeDataArray.length} trees...`);

    for (const tree of treeDataArray) {
        try {
            const newTreeDoc = {
                commonName: tree.name || "Unknown Tree",
                botanicalName: tree.scientific_name || tree["scientific name"] || "Unknown Species",
                locationDescription: `Map Coordinates: x=${tree.x}, y=${tree.y}`,
                originalTreeId: tree.id || null,
                mapCoordinates: { x: tree.x !== undefined ? tree.x : null, y: tree.y !== undefined ? tree.y : null },
                lastWateredDate: Timestamp.fromDate(new Date('2024-01-01')),
                datePlanted: Timestamp.fromDate(new Date('2023-01-01')),
                photoUrl: tree.photo_url || "",
                notes: ""
            };

            await addDoc(treesCollectionRef, newTreeDoc); // Use corrected variable name
            successfulImports++;
            console.log(`Successfully imported: ${newTreeDoc.commonName} (ID: ${newTreeDoc.originalTreeId})`);
        } catch (error) {
            failedImports++;
            console.error(`Failed to import tree with original ID: ${tree.id || 'N/A'}. Error:`, error);
        }
    }

    console.log("Batch import finished.");
    console.log(`Successfully imported: ${successfulImports} trees.`);
    console.log(`Failed to import: ${failedImports} trees.`);
}
window.batchImportTreesFromConsole = batchImportTreesFromConsole;

function getCurrentWeekDateRange() {
    const today = new Date();
    // Set to Monday (0 = Sunday, 1 = Monday, ...)
    const dayOfWeek = today.getDay();
    const monday = new Date(today);
    monday.setDate(today.getDate() - ((dayOfWeek + 6) % 7));
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    // Format as "May 13 – May 19, 2024"
    const options = { month: 'short', day: 'numeric' };
    const year = sunday.getFullYear();
    return `${monday.toLocaleDateString(undefined, options)} – ${sunday.toLocaleDateString(undefined, options)}, ${year}`;
} 