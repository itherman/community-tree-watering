const functions = require("firebase-functions");
const axios = require("axios");
const cors = require("cors")({origin: true});
// Handles CORS for Firebase Functions

/**
 * Proxies requests to the Casey Trees water status page to avoid CORS issues.
 * The frontend can call this function, which then fetches the data server-side.
 */
exports.caseyTreesProxy = functions.https.onRequest((request, response) => {
  // Wrap the main logic in the cors handler
  cors(request, response, async () => {
    if (request.method !== "GET") {
      response.status(405).send("Method Not Allowed");
      return;
    }

    try {
      const targetUrl = "https://caseytrees.org/water/";
      const apiResponse = await axios.get(targetUrl, {
        // Forward some headers if necessary,
        // or set a specific User-Agent.
        // For now, a simple GET request should suffice.
      });

      // Send the HTML content back to the client
      response.status(200).send(apiResponse.data);
    } catch (error) {
      console.error("Error proxying to Casey Trees:", error.message);
      if (error.response) {
        response.status(error.response.status).send(error.response.data);
      } else {
        response.status(500).send("Error fetching data via proxy");
      }
    }
  });
});

// Example for another function:
