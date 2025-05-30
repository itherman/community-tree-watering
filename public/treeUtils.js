// public/treeUtils.js

// Enum-like object for status constants
export const TREE_WATERING_STATUSES = {
    THIRSTY: 'THIRSTY',
    WATER_SOON: 'WATER_SOON',
    OKAY: 'OKAY',
    DONT_WATER: 'DONT_WATER', // Explicit status for "Don't Water" days
    NEVER_WATERED_NEEDS_ATTENTION: 'NEVER_WATERED_NEEDS_ATTENTION', // For new trees that need water
    NEVER_WATERED_OKAY: 'NEVER_WATERED_OKAY', // For new trees when conditions are good
    OKAY_RAIN_EXPECTED: 'OKAY_RAIN_EXPECTED', // Existing tree, okay due to recent or expected rain
    NEVER_WATERED_RAIN_EXPECTED: 'NEVER_WATERED_RAIN_EXPECTED', // New tree, okay due to recent or expected rain
    // NEW statuses to indicate rain is expected but tree still needs attention
    THIRSTY_RAIN_EXPECTED: 'THIRSTY_RAIN_EXPECTED',
    WATER_SOON_RAIN_EXPECTED: 'WATER_SOON_RAIN_EXPECTED',
    NEVER_WATERED_NEEDS_ATTENTION_RAIN_EXPECTED: 'NEVER_WATERED_NEEDS_ATTENTION_RAIN_EXPECTED'
};

const SIGNIFICANT_RAIN_THRESHOLD_INCHES = 1.0; // e.g., 1 inch of rain

/**
 * Calculates the watering status of a tree.
 * @param {object | null} treeData - The tree object.
 * @param {string} lastWateredTimestampField - The field name for the last watered timestamp.
 * @param {string} currentWateringRecommendation - e.g., "Must Water", "Optional", "Don't Water".
 * @param {object | null} forecastContext - Optional. Contains rain data.
 *                                         Example: { rainInNext3DaysInches: 1.4, rainInLast2DaysInches: 0.5 }
 * @returns {string} A status string from TREE_WATERING_STATUSES.
 */
export function calculateTreeWateringStatus(treeData, lastWateredTimestampField, currentWateringRecommendation, forecastContext = null) {
    if (currentWateringRecommendation === "Don't Water") {
        return TREE_WATERING_STATUSES.DONT_WATER;
    }

    const lastWateredValue = treeData ? treeData[lastWateredTimestampField] : null;
    const isNeverWatered = !lastWateredValue;
    let lastWateredDate;

    if (!isNeverWatered) {
        if (lastWateredValue.toDate) {
            lastWateredDate = lastWateredValue.toDate();
        } else {
            lastWateredDate = new Date(lastWateredValue);
        }
        if (isNaN(lastWateredDate.getTime())) {
            console.warn('Invalid lastWateredDate:', lastWateredValue, 'for tree:', treeData.originalTreeId || treeData.commonName);
            return calculateTreeWateringStatus(null, lastWateredTimestampField, currentWateringRecommendation, forecastContext);
        }
    }

    const hasSignificantRecentRain = forecastContext?.rainInLast2DaysInches >= SIGNIFICANT_RAIN_THRESHOLD_INCHES;
    const hasSignificantForecastedRain = forecastContext?.rainInNext3DaysInches >= SIGNIFICANT_RAIN_THRESHOLD_INCHES;

    if (isNeverWatered) {
        if (hasSignificantRecentRain || hasSignificantForecastedRain) {
            console.log(`Tree ${treeData ? (treeData.commonName || treeData.id) : 'Unknown'}: Never watered, but significant rain detected/expected.`);
            return TREE_WATERING_STATUSES.NEVER_WATERED_RAIN_EXPECTED;
        }
        if (currentWateringRecommendation === "Must Water" || currentWateringRecommendation === "Optional") {
            return TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION;
        }
        return TREE_WATERING_STATUSES.NEVER_WATERED_OKAY;
    }

    // --- Logic for Previously Watered Trees ---
    const now = new Date();
    const daysSinceWatered = Math.floor((now.getTime() - lastWateredDate.getTime()) / (24 * 60 * 60 * 1000));
    let baseUrgency;

    if (currentWateringRecommendation === "Must Water") {
        if (daysSinceWatered >= 7) baseUrgency = TREE_WATERING_STATUSES.THIRSTY;
        else if (daysSinceWatered >= 4) baseUrgency = TREE_WATERING_STATUSES.WATER_SOON;
        else baseUrgency = TREE_WATERING_STATUSES.OKAY;
    } else if (currentWateringRecommendation === "Optional") {
        if (daysSinceWatered >= 10) baseUrgency = TREE_WATERING_STATUSES.THIRSTY;
        else if (daysSinceWatered >= 4) baseUrgency = TREE_WATERING_STATUSES.WATER_SOON;
        else baseUrgency = TREE_WATERING_STATUSES.OKAY;
    } else {
        baseUrgency = TREE_WATERING_STATUSES.OKAY; // Default for other recommendations
    }

    // Override with rain considerations
    if (hasSignificantRecentRain) {
        console.log(`Tree ${treeData ? (treeData.commonName || treeData.id) : 'Unknown'}: Significant recent rain (${forecastContext.rainInLast2DaysInches.toFixed(1)}"). Status: OKAY_RAIN_EXPECTED. Base urgency was: ${baseUrgency}`);
        return TREE_WATERING_STATUSES.OKAY_RAIN_EXPECTED; // Recent rain takes precedence
    }

    if (hasSignificantForecastedRain) {
        console.log(`Tree ${treeData ? (treeData.commonName || treeData.id) : 'Unknown'}: Significant forecast rain (${forecastContext.rainInNext3DaysInches.toFixed(1)}"). Base urgency: ${baseUrgency}. Converting to _RAIN_EXPECTED.`);
        switch (baseUrgency) {
            case TREE_WATERING_STATUSES.THIRSTY:
                return TREE_WATERING_STATUSES.THIRSTY_RAIN_EXPECTED;
            case TREE_WATERING_STATUSES.WATER_SOON:
                return TREE_WATERING_STATUSES.WATER_SOON_RAIN_EXPECTED;
            case TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION: // Should be covered by isNeverWatered block, but for safety
                return TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION_RAIN_EXPECTED;
            case TREE_WATERING_STATUSES.OKAY:
                return TREE_WATERING_STATUSES.OKAY_RAIN_EXPECTED;
            case TREE_WATERING_STATUSES.NEVER_WATERED_OKAY: // Should be covered by isNeverWatered block
                return TREE_WATERING_STATUSES.NEVER_WATERED_RAIN_EXPECTED;
            default:
                return baseUrgency; // Should not happen
        }
    }
    
    return baseUrgency; // No significant recent or forecasted rain
}
