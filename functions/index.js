const functions = require("firebase-functions");
const axios = require("axios");
const cors = require("cors")({origin: true});
const admin = require("firebase-admin");
const fetch = require("node-fetch"); // For making HTTP requests

// Import for 2nd Gen scheduled function
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onRequest} = require("firebase-functions/v2/https"); // If you keep caseyTreesProxy as v2
const {setGlobalOptions} = require("firebase-functions/v2");

// If you want to set global options for all v2 functions (e.g., region)
// setGlobalOptions({ region: 'us-central1' }); // Example

admin.initializeApp();
const db = admin.firestore();

const LATITUDE = 38.995270;
const LONGITUDE = -77.039407;

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

// Schedule: Runs every day at 5:00 AM America/New_York timezone.
// Adjust cron expression and timezone as needed.
// See: https://firebase.google.com/docs/functions/schedule-functions
// To deploy, your project must be on the Blaze (pay-as-you-go) plan.
exports.updateWeatherBasedWateringStatus = onSchedule({
    schedule: "0 5 * * *", // 5:00 AM daily
    timeZone: "America/New_York",
    // You can add other options like retryConfig, timeoutSeconds, memory here
    // e.g., timeoutSeconds: 300, memory: "1GiB"
  }, async (event) => {
    console.log("Running daily weather-based watering status update (v2)...");
    console.log("Event context:", JSON.stringify(event)); // See what context is passed

    const weatherApiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${LATITUDE}&longitude=${LONGITUDE}&daily=precipitation_sum,temperature_2m_max,temperature_2m_min&current=temperature_2m&timezone=auto&past_days=3&forecast_days=7`;

    let weatherData;
    try {
      const response = await fetch(weatherApiUrl);
      if (!response.ok) {
        throw new Error(
          `Open-Meteo API request failed: ${response.status} ${response.statusText}`,
        );
      }
      weatherData = await response.json();
      console.log("Successfully fetched weather data (v2):", JSON.stringify(weatherData.daily));
    } catch (error) {
      console.error("Error fetching weather data from Open-Meteo (v2):", error);
      return null; // Exit if weather data isn't available
    }

    if (!weatherData || !weatherData.daily || !weatherData.daily.time) {
      console.error("Weather data is incomplete or missing (v2).");
      return null;
    }

    const daily = weatherData.daily;
    // Open-Meteo's `past_days=3` means the first 3 entries are past days, index 3 is today.
    const actualTodayIndexInArray = 3; 

    if (actualTodayIndexInArray >= daily.time.length || actualTodayIndexInArray < 0) {
        console.error(`Calculated todayIndex (${actualTodayIndexInArray}) is out of bounds for time array length (${daily.time.length}). Weather data times:`, daily.time);
        return null;
    }

    const dailyPrecipitation = daily.precipitation_sum;

    // Assuming past_days=3 gives: dailyPrecipitation[0] = today-2, [1] = today-1, [2] = today
    // And forecast_days=7 gives: dailyPrecipitation[2] through dailyPrecipitation[8] for today through today+6

    const past2DaysRainMM = dailyPrecipitation.slice(0, 2).reduce((a, b) => a + b, 0); // today-2, today-1
    const todayRainMM = dailyPrecipitation[2]; // Rain for today
    // Forecast for next 3 days (today+1, today+2, today+3)
    const forecast3DaysRainMM = dailyPrecipitation.slice(3, 6).reduce((a, b) => a + b, 0);

    // For temperature, let's take an average for the upcoming 3 forecast days (today, tomorrow, day after)
    const dailyMaxTemp = daily.temperature_2m_max;
    const dailyMinTemp = daily.temperature_2m_min;
    const avgMaxTempNext3Days = (dailyMaxTemp[actualTodayIndexInArray] + dailyMaxTemp[actualTodayIndexInArray + 1] + dailyMaxTemp[actualTodayIndexInArray + 2]) / 3;
    const avgMinTempNext3Days = (dailyMinTemp[actualTodayIndexInArray] + dailyMinTemp[actualTodayIndexInArray + 1] + dailyMinTemp[actualTodayIndexInArray + 2]) / 3;

    let status = "Optional"; // Default
    let details = ""; // Initialize details
    const pastRainInches = past2DaysRainMM / 25.4;
    const forecastRainInches = forecast3DaysRainMM / 25.4;
    const combinedRainInches = pastRainInches + forecastRainInches; // Total over relevant past 2 + next 3 days

    // Define thresholds for clarity
    const DONT_WATER_THRESHOLD_RECENT = 1.0;    // Inches in past 2 days
    const DONT_WATER_THRESHOLD_FORECAST = 1.0;  // Inches in next 3 days
    const DONT_WATER_THRESHOLD_COMBINED = 1.5;  // Inches combined (past 2 + next 3)
    const MUST_WATER_THRESHOLD_LOW_RAIN = 0.25; // Threshold for low rain (both past and forecast must be below this)

    if (pastRainInches >= DONT_WATER_THRESHOLD_RECENT || 
        forecastRainInches >= DONT_WATER_THRESHOLD_FORECAST || 
        combinedRainInches >= DONT_WATER_THRESHOLD_COMBINED) {
        status = "Don't Water";
        details = `Sufficient rain expected/received. Past 2 days: ${pastRainInches.toFixed(1)}". Next 3 days: ${forecastRainInches.toFixed(1)}". `; 
    } else if (pastRainInches < MUST_WATER_THRESHOLD_LOW_RAIN && forecastRainInches < MUST_WATER_THRESHOLD_LOW_RAIN) {
        status = "Must Water";
        details = `Very little recent or forecasted rain. Past 2 days: ${pastRainInches.toFixed(1)}". Next 3 days: ${forecastRainInches.toFixed(1)}". Young trees need water. `;
    } else {
        status = "Optional"; // Default if not clearly Don't Water or Must Water
        details = `Assess tree needs. Past 2 days: ${pastRainInches.toFixed(1)}". Next 3 days: ${forecastRainInches.toFixed(1)}". `;
    }
    
    if (dailyMaxTemp && dailyMaxTemp[actualTodayIndexInArray]) {
        const tempMaxC = dailyMaxTemp[actualTodayIndexInArray];
        const tempMaxF = (tempMaxC * 9/5) + 32;
        details += `Today's Max Temp: ${tempMaxF.toFixed(0)}°F.`;
    }

    const processedWeatherData = {
        currentTempC: weatherData.current.temperature_2m,
        minTempTodayC: dailyMinTemp[actualTodayIndexInArray], // today's min temp
        maxTempTodayC: dailyMaxTemp[actualTodayIndexInArray], // today's max temp
        minTempTomorrowC: dailyMinTemp[actualTodayIndexInArray + 1], // tomorrow's min temp
        maxTempTomorrowC: dailyMaxTemp[actualTodayIndexInArray + 1], // tomorrow's max temp
        avgMinTempNext3DaysC: avgMinTempNext3Days,
        avgMaxTempNext3DaysC: avgMaxTempNext3Days,
        past2DaysRainMM: past2DaysRainMM,
        todayRainMM: todayRainMM,
        forecast3DaysRainMM: forecast3DaysRainMM,
        past3DaysRainMM: dailyPrecipitation.slice(0, 3).reduce((a, b) => a + b, 0), // today-2, today-1, today
    };

    const recommendation = {
      status: status,
      details: details.trim(),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      source: "weather_function_v2", // Updated source
      weatherFunctionInput: { latitude: LATITUDE, longitude: LONGITUDE, apiPastDays: 3, apiForecastDays: 7 },
      processedWeatherData: processedWeatherData,
    };

    try {
      const docRef = db.collection("site_config").doc("daily_weather_recommendation");
      await docRef.set(recommendation);
      console.log("Successfully wrote weather-based recommendation to Firestore (v2):", recommendation.status);
    } catch (error) {
      console.error("Error writing recommendation to Firestore (v2):", error);
    }
    return null;
  });
