/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

const {onRequest, onSchedule} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");
const logger = require("firebase-functions/logger");
const axios = require("axios");
const cheerio = require("cheerio");

// Initialize Firebase Admin SDK
initializeApp();
const db = getFirestore();

/**
 * Scrape the Casey Trees watering alert from their website
 * 
 * This function is triggered by an HTTP request, but could also
 * be modified to run on a schedule using the onSchedule trigger.
 */
exports.fetchCaseyTreesWateringAlert = onRequest(
  { 
    cors: true,        // Enable CORS
    maxInstances: 10,  // Limit concurrent instances
    region: 'us-central1',
    invoker: 'public'  // Allow unauthenticated access
  }, 
  async (request, response) => {
  try {
    logger.info("Starting to fetch Casey Trees watering alert...");
    
    // Fetch HTML content from Casey Trees with timeout
    const url = "https://caseytrees.org/water/";
    logger.info(`Requesting page from ${url}`);
    const {data} = await axios.get(url, {
      timeout: 10000, // 10 second timeout
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Load HTML content into cheerio
    const $ = cheerio.load(data);
    
    // Extract the watering alert information using multiple potential selectors
    let status = "Optional"; // Default value if we can't extract the real one
    let details = "";
    let found = false;
    
    // Try multiple potential locations for the alert
    const potentialSelectors = [
      'h2:contains("Weekly Watering Alert")',
      'strong:contains("This week\'s Weekly Watering Alert is:")',
      'p:contains("This week\'s watering alert is:")',
      'h2:contains("Weekly Watering Alert |")'
    ];

    for (const selector of potentialSelectors) {
      const element = $(selector);
      if (element.length > 0) {
        logger.info(`Found alert using selector: ${selector}`);
        // Get the containing paragraph or next paragraph
        const alertText = element.parent().text() || element.next().text();
        
        if (alertText) {
          found = true;
          // Extract status using regex patterns
          if (alertText.match(/is\s+Must\s+Water/i)) {
            status = "Must Water";
          } else if (alertText.match(/is\s+Optional/i)) {
            status = "Optional";
          } else if (alertText.match(/is\s+Don't\s+Water/i) || alertText.match(/is\s+Do\s+Not\s+Water/i)) {
            status = "Don't Water";
          }
          
          // Try to extract details
          const sentences = alertText.split('.');
          for (let i = 0; i < sentences.length; i++) {
            if (sentences[i].includes(status)) {
              // Get the next sentence as details if it exists
              details = sentences[i + 1] ? sentences[i + 1].trim() : '';
              break;
            }
          }
          break;
        }
      }
    }

    // If we couldn't find the alert in the main sections, try the watering alert key
    if (!found || !details) {
      logger.info("Checking watering alert key for details");
      $('em:contains("Watering Alert Key")').parent().find('em').each((i, elem) => {
        const keyText = $(elem).text();
        if (keyText.includes(status)) {
          const parts = keyText.split('–');
          if (parts.length > 1) {
            details = parts[1].trim();
          }
        }
      });
    }
    
    // Ensure we have meaningful details
    if (!details) {
      logger.info("Using fallback details based on status");
      if (status === "Must Water") {
        details = "Very little observed or forecasted rainfall this week. Young trees must be watered.";
      } else if (status === "Optional") {
        details = "Trees may need water, depending on the forecast. Check trees for signs (wilting leaves and/or dry soil) and water as needed.";
      } else if (status === "Don't Water") {
        details = "Recent or predicted rainfall exceeding 1.5 inches this week. Trees have enough water.";
      }
    }
    
    const alertData = {
      status,
      details,
      lastUpdated: new Date(),
      source: url
    };
    
    logger.info(`Extracted alert: ${JSON.stringify(alertData)}`);
    
    // Store the data in Firestore
    await db.collection('site_config').doc('watering_alert').set(alertData);
    
    response.json({
      success: true, 
      message: "Successfully fetched and stored Casey Trees watering alert",
      data: alertData
    });
    
  } catch (error) {
    logger.error("Error fetching Casey Trees watering alert:", error);
    
    // Enhanced error handling with specific error types
    let errorMessage = "Error fetching Casey Trees watering alert";
    let statusCode = 500;
    
    if (error.code === 'ECONNABORTED') {
      errorMessage = "Timeout while fetching watering alert";
      statusCode = 504;
    } else if (error.response) {
      errorMessage = `HTTP ${error.response.status} error from Casey Trees website`;
      statusCode = error.response.status;
    } else if (error.request) {
      errorMessage = "No response received from Casey Trees website";
      statusCode = 503;
    }
    
    // Try to use the last saved alert if available
    try {
      const lastAlertDoc = await db.collection('site_config').doc('watering_alert').get();
      if (lastAlertDoc.exists) {
        const lastAlert = lastAlertDoc.data();
        response.status(statusCode).json({
          success: false,
          message: `${errorMessage} - returning last saved alert from ${lastAlert.lastUpdated.toDate().toISOString()}`,
          error: error.message,
          data: lastAlert
        });
        return;
      }
    } catch (dbError) {
      logger.error("Error fetching last alert from Firestore:", dbError);
    }
    
    // If we can't get the last alert either, return the error
    response.status(statusCode).json({
      success: false, 
      message: errorMessage,
      error: error.message
    });
  }
});

/**
 * Scheduled version of the function - runs daily at midnight
 * Uncomment to enable scheduled execution
 */
/*
exports.scheduledFetchWateringAlert = onSchedule({
  schedule: "0 0 * * *", // Cron syntax: At 00:00 (midnight) every day
  timeZone: "America/New_York" // Eastern Time
}, async (event) => {
  try {
    logger.info("Running scheduled fetch of Casey Trees watering alert...");
    
    // The function logic would be the same as above, just without request/response handling
    // ...
    
    return null;
  } catch (error) {
    logger.error("Error in scheduled fetch:", error);
    return null;
  }
});
*/
