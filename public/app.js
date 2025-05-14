// Import necessary Firebase services and functions from firebase-init.js
import { auth, db, signInAnonymously } from './firebase-init.js';
import { collection, addDoc, Timestamp, getDocs, query, orderBy, doc, getDoc, updateDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js';
// Note: Importing directly from an HTML file like this is unconventional.
// A better practice would be to have a firebaseInit.js that exports these, 
// and both index.html and app.js import from there.
// However, for simplicity with the current setup, we'll try this.
// If this doesn't work, we'll create a separate firebaseInit.js

// App version information
const APP_VERSION = {
    number: '1.0.1',
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
    
    const response = await fetch('https://caseytrees.org/water/');
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();    
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    
    // Try to find the watering alert status
    const alertText = doc.querySelector('.watering-alert, .alert-status, [class*="watering"]')?.textContent || '';
    
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
        const fullText = doc.body.textContent;
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
    
    // Check if we're on a page with watering recommendation elements
    const wateringRecommendationDiv = document.getElementById('watering-recommendation');
    if (!wateringRecommendationDiv) {
        // We're on a different page (like how-to-use), so just return
        return;
    }
    
    // Hide loading animation
    const loadingContainer = wateringRecommendationDiv.querySelector('.loading-container');
    if (loadingContainer) {
        loadingContainer.classList.remove('active');
    }
    
    // Show title and status
    const titleElement = wateringRecommendationDiv.querySelector('h2');
    if (titleElement) {
        titleElement.style.display = 'block';
    }
    
    const statusElement = document.getElementById('casey-trees-alert-status');
    if (statusElement) {
        statusElement.style.display = 'block';
        statusElement.textContent = alertData.status;
    }
    
    if (caseyTreesAlertDetails) {
        caseyTreesAlertDetails.textContent = alertData.details;
        
        // Add last updated timestamp
        const lastUpdateSpan = document.createElement('span');
        lastUpdateSpan.className = 'last-updated';
        const lastUpdated = alertData.lastUpdated?.toDate();
        if (lastUpdated) {
            lastUpdateSpan.textContent = `Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString()}`;
            
            const existingTimestamp = caseyTreesAlertDetails.parentNode?.querySelector('.last-updated');
            if (existingTimestamp) {
                existingTimestamp.remove();
            }
            caseyTreesAlertDetails.parentNode?.insertBefore(lastUpdateSpan, caseyTreesAlertDetails.nextSibling);
        }
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
        loadingContainer.classList.remove('active');

        if (querySnapshot.empty) {
            treeListDiv.innerHTML = '<h2>Thirsty Trees</h2><p>No trees found in the database.</p>';
            return;
        }

        let htmlContent = '';
        let thirstyTreeCount = 0;
        const thirstyTrees = new Set(); // Keep track of thirsty trees

        // Function to check if a tree is thirsty
        const isTreeThirsty = (tree) => {
            if (currentWateringRecommendation === "Don't Water") {
                return false;
            }
            
            const now = new Date();
            if (!tree.lastWateredDate) {
                return currentWateringRecommendation === "Must Water" || 
                       currentWateringRecommendation === "Optional";
            }
            
            const lastWateredDate = tree.lastWateredDate.toDate();
            const daysSinceWatered = Math.floor((now - lastWateredDate) / (24 * 60 * 60 * 1000));
            return daysSinceWatered > 7 && 
                   (currentWateringRecommendation === "Must Water" || 
                    currentWateringRecommendation === "Optional");
        };

        // Get My Grove trees
        const myGrove = getMyGrove();
        if (myGrove.length > 0) {
            htmlContent = `<div class="grove-header">
                <div class="title-row">
                    <span class="material-icons">park</span>
                    <h2>My Grove</h2>
                    <span class="material-icons">park</span>
                </div>
                <div class="tree-border">
                    <span class="material-icons">park</span>
                    <span class="material-icons">park</span>
                    <span class="material-icons">park</span>
                </div>
            </div><ul class="grove-tree-list">`;
            
            // Create a map of tree data for quick lookup
            const treeDataMap = new Map();
            querySnapshot.forEach(doc => {
                treeDataMap.set(doc.id, { ...doc.data(), id: doc.id });
            });
            
            // Add My Grove trees
            myGrove.forEach(treeId => {
                const tree = treeDataMap.get(treeId);
                if (tree) {
                    const lastWateredDate = tree.lastWateredDate ? tree.lastWateredDate.toDate().toLocaleDateString() : 'Never';
                    const treeIsThirsty = isTreeThirsty(tree);
                    if (treeIsThirsty) {
                        thirstyTrees.add(treeId); // Add to thirsty set to avoid duplicate listing
                    }
                    htmlContent += `
                        <li class="tree-item grove" onclick="window.location.href='hoa_trees_map.html?treeId=${treeId}'">
                            <div class="tree-info">
                                <strong>
                                    <span class="material-icons" style="color: #e53935; font-size: 16px; vertical-align: text-bottom;">
                                        favorite
                                    </span>
                                    ${treeIsThirsty ? '<span class="thirsty-emoji">😫</span>' : ''}
                                    ${tree.commonName || 'Unknown Tree'}
                                </strong>
                                <span class="last-watered">Last watered: ${lastWateredDate}</span>
                            </div>
                        </li>
                    `;
                }
            });
            
            htmlContent += '</ul>';
        }

        // Don't show thirsty trees if Casey Trees says don't water
        if (currentWateringRecommendation === "Don't Water") {
            if (!myGrove.length) {
                treeListDiv.innerHTML = '<p class="happy-trees">All trees are happily hydrated thanks to the rain! 🌧️</p>';
            } else {
                treeListDiv.innerHTML = htmlContent + '<h2>Thirsty Trees</h2><p class="happy-trees">All trees are happily hydrated thanks to the rain! 🌧️</p>';
            }
            return;
        }

        // Add Thirsty Trees section
        let thirstyContent = '<h2>Thirsty Trees</h2>';
        querySnapshot.forEach((doc) => {
            const tree = doc.data();
            const treeId = doc.id;
            
            // Skip if this tree is already shown in My Grove
            if (thirstyTrees.has(treeId)) {
                return;
            }
            
            if (isTreeThirsty(tree)) {
                if (thirstyTreeCount === 0) {
                    thirstyContent += '<ul class="thirsty-tree-list">';
                }
                thirstyTreeCount++;
                const lastWateredDate = tree.lastWateredDate ? tree.lastWateredDate.toDate().toLocaleDateString() : 'Never';
                thirstyContent += `
                    <li class="tree-item thirsty" onclick="window.location.href='hoa_trees_map.html?treeId=${treeId}'">
                        <div class="tree-info">
                            <strong><span class="thirsty-emoji">😫</span>${tree.commonName || 'Unknown Tree'}</strong>
                            <span class="last-watered">Last watered: ${lastWateredDate}</span>
                        </div>
                    </li>
                `;
            }
        });

        if (thirstyTreeCount === 0) {
            thirstyContent += '<p class="happy-trees">All our trees are happy and well-watered! 🌳 ✨</p>';
        } else {
            thirstyContent += '</ul>';
        }

        treeListDiv.innerHTML = myGrove.length ? htmlContent + thirstyContent : thirstyContent;

    } catch (error) {
        treeListDiv.innerHTML = '<h2>Thirsty Trees</h2><p>Error loading trees. Please try refreshing the page.</p>';
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