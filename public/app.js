// Import necessary Firebase services and functions from firebase-init.js
import { auth, db, signInAnonymously } from './firebase-init.js';
import { getFirestore, collection, addDoc, Timestamp, getDocs, query, orderBy, doc, getDoc, updateDoc, setDoc } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js';
// Note: Importing directly from an HTML file like this is unconventional.
// A better practice would be to have a firebaseInit.js that exports these, 
// and both index.html and app.js import from there.
// However, for simplicity with the current setup, we'll try this.
// If this doesn't work, we'll create a separate firebaseInit.js

// DOM Elements
const treeListDiv = document.getElementById('tree-list');
const caseyTreesAlertStatus = document.getElementById('casey-trees-alert-status');
const caseyTreesAlertDetails = document.getElementById('casey-trees-alert-details');
let currentWateringRecommendation = "Optional"; // Default, will be updated from Firestore

// Helper function to ensure minimum loading time
async function ensureMinLoadingTime(startTime, minDuration = 1500) {
    const elapsedTime = Date.now() - startTime;
    if (elapsedTime < minDuration) {
        await new Promise(resolve => setTimeout(resolve, minDuration - elapsedTime));
    }
}

function testFirebaseConnection() {
    return db.collection('test').doc('test').get()
        .then(() => {
            // Connection successful
            return true;
        })
        .catch((error) => {
            throw new Error('Failed to connect to Firestore: ' + error);
        });
}

function initializeFirestore() {
    return db.collection('wateringAlert').get()
        .then((snapshot) => {
            if (snapshot.empty) {
                // Initialize with default data
                return db.collection('wateringAlert').add({
                    alertText: 'No alert',
                    timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                    needsWatering: false
                });
            }
        });
}

function authenticateAnonymously() {
    return firebase.auth().signInAnonymously()
        .then((userCredential) => {
            const user = userCredential.user;
            return user;
        });
}

function getInitialData() {
    return db.collection('wateringAlert')
        .orderBy('timestamp', 'desc')
        .limit(1)
        .get()
        .then((snapshot) => {
            if (!snapshot.empty) {
                return snapshot.docs[0].data();
            }
            return null;
        });
}

function checkFirestore() {
    return new Promise((resolve, reject) => {
        const maxAttempts = 10;
        let attempts = 0;

        function tryConnection() {
            db.collection('wateringAlert')
                .orderBy('timestamp', 'desc')
                .limit(1)
                .get()
                .then((snapshot) => {
                    resolve(snapshot);
                })
                .catch((error) => {
                    attempts++;
                    if (attempts < maxAttempts) {
                        setTimeout(tryConnection, 1000);
                    } else {
                        reject(new Error('Failed to connect to Firestore after multiple attempts'));
                    }
                });
        }

        tryConnection();
    });
}

async function fetchCaseyTreesAlert() {
    try {
        const response = await fetch('https://caseytrees.org/');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const html = await response.text();
        
        // Extract alert text using regex
        const alertRegex = /<div[^>]*class="[^"]*watering-alert[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
        const match = html.match(alertRegex);
        
        if (match) {
            let alertText = match[1].trim();
            // Remove HTML tags
            alertText = alertText.replace(/<[^>]*>/g, '').trim();
            
            // Determine if watering is needed
            const needsWatering = alertText.toLowerCase().includes('water') && 
                                !alertText.toLowerCase().includes('no need to water') &&
                                !alertText.toLowerCase().includes('don\'t water');

            const alertData = {
                alertText: alertText,
                timestamp: firebase.firestore.FieldValue.serverTimestamp(),
                needsWatering: needsWatering
            };

            // Store in Firestore
            await db.collection('wateringAlert').add(alertData);

            return alertData;
        }
        
        throw new Error('Alert text not found on page');
        
    } catch (error) {
        throw new Error('Failed to fetch Casey Trees alert: ' + error.message);
    }
}

// Function to sign in a user anonymously
const anonCreateUser = async () => {
    try {
        // Test Firebase connection
        await testFirebaseConnection();
        
        // Initialize Firestore if needed
        await initializeFirestore();
        
        // Authenticate user
        const user = await authenticateAnonymously();
        
        // Get initial data
        const initialData = await getInitialData();
        
        // Check Firestore connection
        await checkFirestore();
        
        // Fetch fresh data from Casey Trees
        const alertData = await fetchCaseyTreesAlert();
        
        // Display the initial/existing data
        await displayWateringAlert(initialData);
        
        // Then try to get fresh data
        await getAndUpdateWateringAlert();
        
        // Load the trees based on the alert status
        await loadTrees();
    } catch (error) {
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

        // If data is stale or doesn't exist, fetch from Casey Trees
        if (shouldFetchFromCaseyTrees) {
            try {
                await fetchAndStoreCaseyTreesAlert();
            } catch (fetchError) {
                // Keep displaying the current data, just log the error
            }
        }
        
    } catch (error) {
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
    
    const alertDocRef = doc(db, 'site_config', 'watering_alert');
    await setDoc(alertDocRef, alertData);
    await displayWateringAlert(alertData);
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
    
    // Hide loading animation
    const loadingContainer = document.querySelector('#watering-recommendation .loading-container');
    loadingContainer.classList.remove('active');
    
    // Show status
    const statusElement = document.getElementById('casey-trees-alert-status');
    statusElement.style.display = 'block';
    statusElement.textContent = alertData.status;
    
    if (caseyTreesAlertDetails) {
        caseyTreesAlertDetails.textContent = alertData.details;
    }
    
    // Add last updated timestamp
    const lastUpdateSpan = document.createElement('span');
    lastUpdateSpan.className = 'last-updated';
    const lastUpdated = alertData.lastUpdated?.toDate();
    if (lastUpdated) {
        lastUpdateSpan.textContent = `Last updated: ${lastUpdated.toLocaleDateString()} ${lastUpdated.toLocaleTimeString()}`;
        
        if (caseyTreesAlertDetails && caseyTreesAlertDetails.parentNode) {
            const existingTimestamp = caseyTreesAlertDetails.parentNode.querySelector('.last-updated');
            if (existingTimestamp) {
                existingTimestamp.remove();
            }
            caseyTreesAlertDetails.parentNode.insertBefore(lastUpdateSpan, caseyTreesAlertDetails.nextSibling);
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

        // Don't show thirsty trees if Casey Trees says don't water
        if (currentWateringRecommendation === "Don't Water") {
            treeListDiv.innerHTML = '<p class="happy-trees">All trees are happily hydrated thanks to the rain! 🌧️</p>';
            return;
        }

        querySnapshot.forEach((doc) => {
            const tree = doc.data();
            const treeId = doc.id;
            
            let isThirsty = false;
            const now = new Date();
            
            if (tree.lastWateredDate) {
                const lastWateredDate = tree.lastWateredDate.toDate();
                // Calculate exact days since last watered
                const daysSinceWatered = Math.floor((now - lastWateredDate) / (24 * 60 * 60 * 1000));
                
                // Only consider thirsty if:
                // 1. Last watered MORE THAN 7 days ago (i.e., 8 or more days)
                // 2. Casey Trees status is "Must Water" or "Optional"
                if (daysSinceWatered > 7 && 
                    (currentWateringRecommendation === "Must Water" || 
                     currentWateringRecommendation === "Optional")) {
                    isThirsty = true;
                }
            } else {
                // If never watered and recommendation is to water, it's thirsty
                if (currentWateringRecommendation === "Must Water" || 
                    currentWateringRecommendation === "Optional") {
                    isThirsty = true;
                }
            }

            if (isThirsty) {
                // Only add the title when we find our first thirsty tree
                if (thirstyTreeCount === 0) {
                    htmlContent = '<h2>Thirsty Trees</h2><ul class="thirsty-tree-list">';
                }
                thirstyTreeCount++;
                const lastWateredDate = tree.lastWateredDate ? tree.lastWateredDate.toDate().toLocaleDateString() : 'Never';
                htmlContent += `
                    <li class="tree-item thirsty" onclick="window.location.href='hoa_trees_map.html?tree=${treeId}'">
                        <div class="tree-info">
                            <strong><span class="thirsty-emoji">😫</span>${tree.commonName || 'Unknown Tree'}</strong>
                            <span class="last-watered">Last watered: ${lastWateredDate}</span>
                        </div>
                    </li>
                `;
            }
        });

        if (thirstyTreeCount === 0) {
            treeListDiv.innerHTML = '<p class="happy-trees">All our trees are happy and well-watered! 🌳 ✨</p>';
            return;
        }

        htmlContent += '</ul>';
        treeListDiv.innerHTML = htmlContent;

    } catch (error) {
        treeListDiv.innerHTML = '<h2>Thirsty Trees</h2><p>Error loading trees. Please check the console.</p>';
    }
}

// --- "I Watered This!" button functionality ---
window.updateLastWatered = async (treeId) => {
    if (!db) {
        alert('Error: Database not connected.');
        return;
    }
    if (!auth.currentUser) {
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
        alert(`Error: Failed to update watering date. ${error.message}`);
    }
};

// Call the initial function to sign in and load data
window.loadStartTime = Date.now(); // Set initial load start time
anonCreateUser();

// --- Batch Import Function (Keep for console use if needed, or remove if done) ---
async function importTreeData(treeDataArray) {
    const batch = db.batch();
    let successfulImports = 0;
    let failedImports = 0;

    for (const treeData of treeDataArray) {
        try {
            const newTreeDoc = {
                ...treeData,
                timestamp: firebase.firestore.FieldValue.serverTimestamp()
            };

            const treeRef = db.collection('trees').doc();
            batch.set(treeRef, newTreeDoc);
            successfulImports++;
        } catch (error) {
            failedImports++;
        }
    }

    await batch.commit();

    return { successfulImports, failedImports };
}
window.importTreeData = importTreeData;