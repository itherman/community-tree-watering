// public/treeUtils.js

// Enum-like object for status constants
export const TREE_WATERING_STATUSES = {
    THIRSTY: 'THIRSTY',
    WATER_SOON: 'WATER_SOON',
    OKAY: 'OKAY',
    DONT_WATER: 'DONT_WATER', // Explicit status for "Don't Water" days
    NEVER_WATERED_NEEDS_ATTENTION: 'NEVER_WATERED_NEEDS_ATTENTION', // For new trees that need water
    NEVER_WATERED_OKAY: 'NEVER_WATERED_OKAY' // For new trees when conditions are good
};

/**
 * Calculates the watering status of a tree.
 * @param {object | null} treeData - The tree object. Expected to have a lastWateredTimestampField.
 * @param {string} lastWateredTimestampField - The field name for the last watered timestamp (e.g., 'lastWateredDate').
 * @param {string} currentWateringRecommendation - e.g., "Must Water", "Optional", "Don't Water".
 * @returns {string} A status string from TREE_WATERING_STATUSES.
 */
export function calculateTreeWateringStatus(treeData, lastWateredTimestampField, currentWateringRecommendation) {
    if (currentWateringRecommendation === "Don\'t Water") {
        return TREE_WATERING_STATUSES.DONT_WATER;
    }

    const lastWateredValue = treeData ? treeData[lastWateredTimestampField] : null;

    if (!lastWateredValue) {
        // If never watered, status depends on the general recommendation
        if (currentWateringRecommendation === "Must Water" || currentWateringRecommendation === "Optional") {
            return TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION;
        } else {
            // This case should ideally not happen if "Don't Water" is handled first,
            // but as a fallback, consider it okay.
            return TREE_WATERING_STATUSES.NEVER_WATERED_OKAY;
        }
    }

    let lastWateredDate;
    if (lastWateredValue.toDate) { // Firestore Timestamp
        lastWateredDate = lastWateredValue.toDate();
    } else { // Date object or string
        lastWateredDate = new Date(lastWateredValue);
    }

    if (isNaN(lastWateredDate.getTime())) {
        console.warn('Invalid lastWateredDate:', lastWateredValue);
        // Treat as never watered if date is invalid
        if (currentWateringRecommendation === "Must Water" || currentWateringRecommendation === "Optional") {
            return TREE_WATERING_STATUSES.NEVER_WATERED_NEEDS_ATTENTION;
        } else {
            return TREE_WATERING_STATUSES.NEVER_WATERED_OKAY;
        }
    }
    
    const now = new Date();
    const daysSinceWatered = Math.floor((now.getTime() - lastWateredDate.getTime()) / (24 * 60 * 60 * 1000));

    if (currentWateringRecommendation === "Must Water") {
        if (daysSinceWatered >= 7) return TREE_WATERING_STATUSES.THIRSTY;
        if (daysSinceWatered >= 4) return TREE_WATERING_STATUSES.WATER_SOON;
    } else if (currentWateringRecommendation === "Optional") {
        if (daysSinceWatered >= 10) return TREE_WATERING_STATUSES.THIRSTY;
        if (daysSinceWatered >= 4) return TREE_WATERING_STATUSES.WATER_SOON; // 4-9 days for Optional
    }

    return TREE_WATERING_STATUSES.OKAY;
} 