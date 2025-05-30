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
    number: '1.1.0',
    name: 'Grove Guardian',
    lastUpdated: '2025-05-20'
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
        // const user = userCredential.user; // user variable is not used, can be removed if not needed elsewhere later
        
        // Initialize Firestore if needed, but DO NOT display its result directly here.
        await initializeFirestoreIfNeeded(); 
        
        // getAndUpdateWateringAlert will now handle all data fetching, the single final display,
        // and the subsequent call to loadTrees with the correct forecastContext.
        await getAndUpdateWateringAlert();
        
        // DO NOT call loadTrees() here again. It's called at the end of getAndUpdateWateringAlert.
        // await loadTrees(); // This was the redundant call causing the flash.

    } catch (error) {
        console.error("Error in initialization:", error);
        if (treeListDiv) treeListDiv.innerHTML = '<p>Error initializing application. Please try refreshing the page.</p>';
        // Also ensure loading animation is hidden on critical init error
        const wateringRecommendationDiv = document.getElementById('watering-recommendation');
        const loadingContainer = wateringRecommendationDiv ? wateringRecommendationDiv.querySelector('.loading-container') : null;
        if (loadingContainer) loadingContainer.classList.remove('active');
        const titleElement = wateringRecommendationDiv ? wateringRecommendationDiv.querySelector('h2') : null;
        if (titleElement) titleElement.style.display = 'block'; 
    }
};

// REVISED Function to get and display watering alert using shared logic
async function getAndUpdateWateringAlert() {
    const wateringRecommendationDiv = document.getElementById('watering-recommendation');
    const loadingContainer = wateringRecommendationDiv ? wateringRecommendationDiv.querySelector('.loading-container') : null;
    // Ensure loading animation might need to be managed if active states are handled outside

    try {
        if (!db || !Timestamp || !doc || !getDoc || !setDoc) {
            throw new Error('Firestore SDK components not available for shared logic!');
        }

        console.log("App.js: Calling shared determineOverallWateringStatus...");
        // Call the shared function to get the determined status and context
        // The shared function now handles updating 'site_config/watering_alert' itself.
        const { finalAlertDataToDisplay, forecastContext } = await determineOverallWateringStatus(db, Timestamp, doc, getDoc, setDoc);
        console.log("App.js: Shared logic returned status:", finalAlertDataToDisplay.status);

        if (finalAlertDataToDisplay) {
            await displayWateringAlert(finalAlertDataToDisplay);
        } else {
            // This case should ideally be handled within determineOverallWateringStatus with a failsafe default
            console.error("App.js: CRITICAL - determineOverallWateringStatus did not return data. Displaying fallback.");
            await displayWateringAlert({
                status: "Optional",
                details: "Watering status determination failed. Check trees manually.",
                lastUpdated: Timestamp.now(), // Firestore Timestamp needed here
                source: 'critical_shared_logic_failure'
            });
        }
        
        // Load trees with the context from the shared logic
        await loadTrees(forecastContext);

    } catch (error) {
        console.error("Critical error in getAndUpdateWateringAlert (app.js using shared logic):", error);
        if (loadingContainer) loadingContainer.classList.remove('active');
        const titleElement = wateringRecommendationDiv ? wateringRecommendationDiv.querySelector('h2') : null;
        if (titleElement) titleElement.style.display = 'block';

        await displayWateringAlert({
            status: "Optional",
            details: "System error encountered. Please check trees for watering needs.",
            lastUpdated: Timestamp.now(), // Firestore Timestamp needed here
            source: 'critical_error_app_js'
        });
        await loadTrees(null); // Load trees with no specific forecast context on error
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

        // Remove existing status classes
        statusElement.classList.remove('status-must-water', 'status-optional', 'status-dont-water');

        // Add new class based on status
        if (alertData.status === "Must Water") {
            statusElement.classList.add('status-must-water');
        } else if (alertData.status === "Optional") {
            statusElement.classList.add('status-optional');
        } else if (alertData.status === "Don't Water") {
            statusElement.classList.add('status-dont-water');
        }
    }
    
    const detailsElement = document.getElementById('casey-trees-alert-details');
    const metaDataElement = document.getElementById('alert-meta-data');

    if (detailsElement) {
        // Use the details from alertData if provided, otherwise default to effective date.
        // The weather function and admin override provide their own details.
        let displayDetails = alertData.details || `Effective: ${getCurrentWeekDateRange()}`;
        // If the source is Casey Trees default and no specific details, use the effective date.
        if (alertData.source === 'default' && !alertData.details) {
             displayDetails = `Effective: ${getCurrentWeekDateRange()}`;
        } else if (alertData.source === 'https://caseytrees.org/water/' && !alertData.details) {
            // If from Casey Trees scrape and details are minimal/not parsed, also show effective date.
            displayDetails = alertData.details || `Effective: ${getCurrentWeekDateRange()}`;
        }
        detailsElement.textContent = displayDetails;
    }

    if (metaDataElement) {
        let sourceName = 'Casey Trees';
        let sourceUrl = 'https://caseytrees.org/water/';

        if (alertData.source === 'weather_function_v2') {
            sourceName = 'Open-Meteo';
            sourceUrl = 'https://open-meteo.com/';
            // Details are already set from alertData.details from the function
        } else if (alertData.source === 'admin_override') {
            sourceName = 'Admin Override';
            sourceUrl = '#'; // No specific link for admin override
        } else if (alertData.source && alertData.source.startsWith('fetch_error')) {
            sourceName = 'System Alert';
            sourceUrl = '#';
        } else if (alertData.source && alertData.source.startsWith('failsafe')) {
            sourceName = 'System Alert';
            sourceUrl = '#';
        } else if (alertData.source && alertData.source.startsWith('critical_error')) {
            sourceName = 'System Error';
            sourceUrl = '#';
        }
        // Default remains Casey Trees if not explicitly weather_function_v2 or admin_override

        let metaHTML = sourceUrl !== '#' ? 
            `Source: <a href="${sourceUrl}" target="_blank" rel="noopener noreferrer">${sourceName}</a>` : 
            `Source: ${sourceName}`;
            
        const lastUpdated = alertData.lastUpdated?.toDate();
        if (lastUpdated) {
            metaHTML += ` <span class="meta-separator">|</span> Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        }
        metaDataElement.innerHTML = metaHTML;
    }
}

// --- Load and Display Thirsty Trees Only ---
async function loadTrees(forecastContext = null) {
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
            switch (statusConstant) {
                case TREE_WATERING_STATUSES.THIRSTY:
                    return { message: '💧 Water within 1 day', cssClassKey: 'thirsty' };
                case TREE_WATERING_STATUSES.WATER_SOON:
                    return { message: '💧 Water within 3 days', cssClassKey: 'water-soon' };
                case TREE_WATERING_STATUSES.OKAY:
                    return { message: '✔️ OK for now', cssClassKey: 'okay' };
                case TREE_WATERING_STATUSES.DONT_WATER:
                    return { message: '🛑 Do NOT water', cssClassKey: 'dont-water' };
                case TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION:
                    return { message: '⚠️ New tree, needs water!', cssClassKey: 'thirsty' }; // Visually same as thirsty
                case TREE_WATERING_STATUSES.NEVER_WATERED_OKAY:
                    return { message: '✔️ New tree, OK for now', cssClassKey: 'okay' };
                case TREE_WATERING_STATUSES.OKAY_RAIN_EXPECTED:
                    return { message: '🌧️ Rain expected soon, OK', cssClassKey: 'okay-rain-expected' };
                case TREE_WATERING_STATUSES.NEVER_WATERED_RAIN_EXPECTED:
                    return { message: '🌧️ New tree, rain expected', cssClassKey: 'okay-rain-expected' }; // Same class as OKAY_RAIN_EXPECTED
                // NEWLY ADDED STATUSES
                case TREE_WATERING_STATUSES.THIRSTY_RAIN_EXPECTED:
                    return { message: '💧 Rain expected, but still thirsty!', cssClassKey: 'thirsty-rain-expected' }; 
                case TREE_WATERING_STATUSES.WATER_SOON_RAIN_EXPECTED:
                    return { message: '💧 Rain expected, but water soon', cssClassKey: 'water-soon-rain-expected' };
                case TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION_RAIN_EXPECTED:
                    return { message: '⚠️ Rain expected, new tree needs water!', cssClassKey: 'thirsty-rain-expected' }; // Visually similar to thirsty
                default:
                    console.warn('Unknown tree status:', statusConstant);
                    return { message: 'Status unknown', cssClassKey: 'unknown' };
            }
        }

        // Renamed function: Determines the watering status of a tree
        const getTreeWateringStatus = (tree) => {
            // Delegate to the centralized utility function, now passing forecastContext
            return calculateTreeWateringStatus(tree, 'lastWateredDate', currentWateringRecommendation, forecastContext);
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
                    if (displayDetails.message) {
                        statusMessageHTML = `<span class="tree-status-message ${displayDetails.cssClassKey}">${displayDetails.message}</span>`;
                    }

                    let itemClass = 'grove'; 
                    // Determine if an alert class should be added based on the status cssClassKey
                    if (displayDetails.cssClassKey === 'thirsty' || displayDetails.cssClassKey === 'thirsty-rain-expected') {
                        itemClass += ' thirsty-alert';
                    } else if (displayDetails.cssClassKey === 'water-soon' || displayDetails.cssClassKey === 'water-soon-rain-expected') {
                        itemClass += ' water-soon-alert';
                    } else if (displayDetails.cssClassKey === 'okay-rain-expected') {
                        itemClass += ' okay-rain-expected-alert';
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
            let liItemAlertClass = ''; // To store thirsty-alert or water-soon-alert

            // Determine which list the tree belongs to and its LI alert class
            switch (displayDetails.cssClassKey) {
                case 'thirsty':
                case 'thirsty-rain-expected': // Covers NEVER_WATERED_NEEDS_ATTENTION_RAIN_EXPECTED if its cssClassKey is 'thirsty-rain-expected'
                    listToAdd = 'thirsty';
                    liItemAlertClass = 'thirsty-alert';
                    break;
                case 'water-soon':
                case 'water-soon-rain-expected':
                    listToAdd = 'waterSoon';
                    liItemAlertClass = 'water-soon-alert';
                    break;
                case 'okay-rain-expected': // Add this for general lists, though it won't be added to thirsty/waterSoon lists
                    liItemAlertClass = 'okay-rain-expected-alert'; // This won't be used by current list logic but good for consistency
                    // No listToAdd for okay statuses in general lists
                    return;
                default:
                    // Skip this tree if it doesn't fall into an actionable category for general lists
                    // This includes 'okay', 'dont-water', etc.
                    return; 
            }

            if (listToAdd) {
                listItemHTML = `
                    <li class="tree-item ${liItemAlertClass}" onclick="window.location.href='hoa_trees_map.html?treeId=${treeId}'">
                        <div class="tree-info">
                            <strong>${tree.commonName || 'Unknown Tree'}</strong>
                            <span class="tree-status-message ${displayDetails.cssClassKey}">${displayDetails.message}</span>
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
                // Updated logic to use TREE_WATERING_STATUSES constants directly for clarity
                return status === TREE_WATERING_STATUSES.THIRSTY || 
                       status === TREE_WATERING_STATUSES.WATER_SOON || 
                       status === TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION ||
                       status === TREE_WATERING_STATUSES.THIRSTY_RAIN_EXPECTED ||
                       status === TREE_WATERING_STATUSES.WATER_SOON_RAIN_EXPECTED ||
                       status === TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION_RAIN_EXPECTED;
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