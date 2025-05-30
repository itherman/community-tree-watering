// Shared Status Logic for Grove Guardian

// Helper function to check if data is stale (older than X hours)
// Note: Timestamp needs to be accessible, e.g., from Firebase SDK if not passed directly.
function isDataStale(timestamp, hours = 24) {
    if (!timestamp) return true;
    
    // Ensure timestamp is a Date object
    const lastUpdated = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    
    const threshold = new Date();
    threshold.setHours(threshold.getHours() - hours);
    
    return lastUpdated < threshold;
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

// Placeholder for fetching Casey Trees alert - to be expanded
// This will need access to db, Timestamp, setDoc, doc from Firestore, and DOMParser
async function fetchAndStoreCaseyTreesAlertShared(db, Timestamp, doc, setDoc) {
    console.log("Shared: Attempting to fetch from Casey Trees proxy...");
    const response = await fetch('https://us-central1-community-tree-watering.cloudfunctions.net/caseyTreesProxy');
    
    if (!response.ok) {
        console.error("Shared: Casey Trees Proxy HTTP error!", response.status);
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const html = await response.text();    
    const parser = new DOMParser();
    const parsedHtmlDoc = parser.parseFromString(html, 'text/html');
    
    const alertText = parsedHtmlDoc.querySelector('.watering-alert, .alert-status, [class*="watering"]')?.textContent || '';
    
    let status = null;
    let details = "";
    
    if (alertText.toLowerCase().includes('must water')) {
        status = 'Must Water';
    } else if (alertText.toLowerCase().includes('optional')) {
        status = 'Optional';
    } else if (alertText.toLowerCase().includes("don't water") || alertText.toLowerCase().includes('do not water')) {
        status = "Don't Water";
    }
    
    if (!status) {
        const fullText = parsedHtmlDoc.body.textContent;
        const statusMatch = fullText.match(/Weekly Watering Alert\\s*\\|\\s*(Must Water|Optional|Don't Water)/i);
        if (statusMatch) {
            status = statusMatch[1];
            const afterStatus = fullText.substring(fullText.indexOf(statusMatch[0]) + statusMatch[0].length);
            const nextPeriod = afterStatus.indexOf('.');
            if (nextPeriod > 0) {
                details = afterStatus.substring(0, nextPeriod).trim();
            }
        }
    }
    
    if (!status) {
        console.error("Shared: Could not find watering status on Casey Trees website");
        throw new Error("Shared: Could not find watering status on Casey Trees website");
    }
    
    if (!details) {
        details = getDefaultDetails(status); // Uses shared getDefaultDetails
    }
    
    const alertData = {
        status,
        details,
        lastUpdated: Timestamp.now(), // Firestore Timestamp
        source: 'https://caseytrees.org/water/'
    };
        
    try {
        const alertDocRef = doc(db, 'site_config', 'watering_alert'); // Firestore doc
        await setDoc(alertDocRef, alertData); // Firestore setDoc
        console.log("Shared: Casey Trees alert stored in Firestore:", alertData.status);
        return alertData;
    } catch (error) {
        console.error("Shared: Error storing Casey Trees alert in Firestore:", error);
        throw error;
    }
}

// This function will encapsulate the decision logic.
// It needs db, Timestamp, doc, getDoc, setDoc from Firestore.
async function determineOverallWateringStatus(db, Timestamp, doc, getDoc, setDoc) {
    let finalAlertDataToDisplay = null;
    let alertSourceForLogging = 'init_shared';
    let forecastContext = null; // Keep this for potential future use if logic expands

    const mainAlertDocRef = doc(db, 'site_config', 'watering_alert');
    const weatherRecDocRef = doc(db, 'site_config', 'daily_weather_recommendation');

    const [mainAlertSnap, weatherRecSnap] = await Promise.all([
        getDoc(mainAlertDocRef),
        getDoc(weatherRecDocRef)
    ]);

    // Priority 1: Admin Override
    if (mainAlertSnap.exists()) {
        const mainAlert = mainAlertSnap.data();
        if (mainAlert.source === 'admin_override' && mainAlert.overrideUntil && mainAlert.overrideUntil.toDate() > new Date()) {
            finalAlertDataToDisplay = mainAlert;
            alertSourceForLogging = 'admin_override_shared';
        }
    }

    // Priority 2: Casey Trees "Don't Water" (if no active admin override)
    if (!finalAlertDataToDisplay && mainAlertSnap.exists()) {
        const mainAlert = mainAlertSnap.data();
        const isCaseyTreesSource = mainAlert.source === 'https://caseytrees.org/water/' || mainAlert.source === 'default';
        // Use shared isDataStale
        if (isCaseyTreesSource && mainAlert.status === "Don't Water" && !isDataStale(mainAlert.lastUpdated)) { 
            finalAlertDataToDisplay = mainAlert;
            alertSourceForLogging = 'casey_trees_recent_dont_water_shared';
        }
    }

    // Priority 3: Daily Weather Recommendation (if no decision yet)
    if (!finalAlertDataToDisplay && weatherRecSnap.exists()) {
        const wrData = weatherRecSnap.data();
        const weatherLastUpdated = wrData.lastUpdated ? wrData.lastUpdated.toDate() : null;
        if (weatherLastUpdated) {
            const hoursSinceUpdate = (new Date() - weatherLastUpdated) / (1000 * 60 * 60);
            if (hoursSinceUpdate <= 30) { 
                finalAlertDataToDisplay = wrData;
                alertSourceForLogging = 'weather_function_shared';
                if (wrData.processedWeatherData) {
                    forecastContext = {};
                    if (typeof wrData.processedWeatherData.forecast3DaysRainMM === 'number') {
                        forecastContext.rainInNext3DaysInches = wrData.processedWeatherData.forecast3DaysRainMM / 25.4;
                    }
                    if (typeof wrData.processedWeatherData.past2DaysRainMM === 'number') {
                        forecastContext.rainInLast2DaysInches = wrData.processedWeatherData.past2DaysRainMM / 25.4;
                    }
                }
            } else {
                console.log('Shared Info: Daily weather recommendation is stale.');
            }
        }
    }

    // Priority 4: Fallback to Casey Trees (scrape or use existing if not decided)
    if (!finalAlertDataToDisplay) {
        let shouldFetchFromCaseyTrees = false;
        if (mainAlertSnap.exists()) {
            const mainAlert = mainAlertSnap.data();
            if (mainAlert.source === 'automation_requested' || 
                (mainAlert.source === 'admin_override' && mainAlert.overrideUntil && mainAlert.overrideUntil.toDate() <= new Date()) ||
                isDataStale(mainAlert.lastUpdated)) {
                shouldFetchFromCaseyTrees = true;
            } else {
                finalAlertDataToDisplay = mainAlert;
                alertSourceForLogging = 'existing_fresh_casey_trees_shared';
            }
        } else { 
            shouldFetchFromCaseyTrees = true;
        }

        if (shouldFetchFromCaseyTrees) {
            console.log('Shared Action: Proceeding to fetch from Casey Trees.');
            try {
                // Call the shared fetch function, passing necessary Firebase components
                finalAlertDataToDisplay = await fetchAndStoreCaseyTreesAlertShared(db, Timestamp, doc, setDoc);
                alertSourceForLogging = finalAlertDataToDisplay.source || 'casey_trees_fetched_shared';
            } catch (fetchError) {
                console.error("Shared Error: Fetching from Casey Trees failed.", fetchError);
                finalAlertDataToDisplay = {
                    status: "Optional",
                    details: "Unable to fetch latest watering status. Please check trees manually.",
                    lastUpdated: Timestamp.now(),
                    source: 'fetch_error_default_shared'
                };
                alertSourceForLogging = 'fetch_error_default_shared';
            }
        }
    }

    // If, after all logic, no decision, use a failsafe default.
    if (!finalAlertDataToDisplay) {
        console.log('Shared CRITICAL FALLBACK: No watering status determined. Using failsafe.');
        finalAlertDataToDisplay = {
            status: "Optional",
            details: "Watering status could not be determined. Check trees manually.",
            lastUpdated: Timestamp.now(),
            source: 'failsafe_default_shared'
        };
        alertSourceForLogging = 'failsafe_default_shared';
    }
    
    // Update the main watering_alert document with the final determined status
    // This is crucial for synchronizing all listeners (admin.js, app.js)
    if (finalAlertDataToDisplay) {
        try {
            console.log(`Shared Info: Updating 'watering_alert' with final status from source: ${alertSourceForLogging}`);
            await setDoc(mainAlertDocRef, finalAlertDataToDisplay, { merge: true });
            console.log("Shared Success: 'watering_alert' updated with final determined status:", finalAlertDataToDisplay.status);
        } catch (error) {
            console.error("Shared Error: Failed to update 'watering_alert' with final status:", error);
            // If this fails, the listeners might not see the most up-to-date status.
            // However, finalAlertDataToDisplay still holds the determined status for the caller.
        }
    }

    return { finalAlertDataToDisplay, alertSourceForLogging, forecastContext };
} 