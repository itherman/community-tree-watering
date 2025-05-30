// Import Firebase services from firebase-init.js (make sure this path is correct)
import { auth, db } from './firebase-init.js';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js';
import { doc, getDoc, setDoc, Timestamp, serverTimestamp, updateDoc, deleteField, onSnapshot } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js';

// DOM Elements
const authContainer = document.getElementById('auth-container');
const adminControls = document.getElementById('admin-controls');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const signInButton = document.getElementById('signInButton');
const signOutButton = document.getElementById('signOutButton');
const authError = document.getElementById('auth-error');
const adminMessage = document.getElementById('admin-message');

const userEmailDisplay = document.getElementById('user-email-display');

// Current Status Display Elements
const currentStatusText = document.getElementById('current-status-text');
const currentDetailsText = document.getElementById('current-details-text');
const currentSourceText = document.getElementById('current-source-text');
const currentLastUpdatedText = document.getElementById('current-last-updated-text');
const currentOverrideUntilText = document.getElementById('current-override-until-text');

// Manual Control Elements
const manualStatusSelect = document.getElementById('manualStatus');
const manualDetailsInput = document.getElementById('manualDetails');
const overrideDurationInput = document.getElementById('overrideDuration');
const setManualStatusButton = document.getElementById('setManualStatusButton');
const revertToAutoButton = document.getElementById('revertToAutoButton');

const siteConfigRef = doc(db, 'site_config', 'watering_alert');

// --- Authentication ---
signInButton.addEventListener('click', async () => {
    const email = emailInput.value;
    const password = passwordInput.value;
    try {
        await signInWithEmailAndPassword(auth, email, password);
        authError.classList.add('hidden');
        authError.textContent = '';
    } catch (error) {
        console.error('Sign-in error:', error);
        authError.textContent = `Sign-in failed: ${error.message}`;
        authError.classList.remove('hidden');
    }
});

signOutButton.addEventListener('click', async () => {
    try {
        await signOut(auth);
    } catch (error) {
        console.error('Sign-out error:', error);
    }
});

let unsubscribeWateringStatus = null; // To store the unsubscribe function

onAuthStateChanged(auth, (user) => {
    if (user && !user.isAnonymous) {
        authContainer.classList.add('hidden');
        adminControls.classList.remove('hidden');
        userEmailDisplay.textContent = user.email;
        subscribeToWateringStatus();
    } else {
        authContainer.classList.remove('hidden');
        adminControls.classList.add('hidden');
        userEmailDisplay.textContent = '';
        if (user && user.isAnonymous) {
            signOut(auth).catch(err => console.warn("Error signing out anonymous user on admin page:", err));
        }
        clearAdminMessage();
        if (unsubscribeWateringStatus) {
            unsubscribeWateringStatus();
            unsubscribeWateringStatus = null;
        }
    }
});

// --- Watering Status Management ---
function subscribeToWateringStatus() {
    if (unsubscribeWateringStatus) {
        unsubscribeWateringStatus();
    }
    unsubscribeWateringStatus = onSnapshot(siteConfigRef, (docSnap) => {
        if (docSnap.exists()) {
            const data = docSnap.data();
            currentStatusText.textContent = data.status || 'N/A';
            currentDetailsText.textContent = data.details || 'N/A';
            currentSourceText.textContent = data.source || 'N/A';
            currentLastUpdatedText.textContent = data.lastUpdated ? data.lastUpdated.toDate().toLocaleString() : 'N/A';
            
            if (data.overrideUntil && typeof data.overrideUntil.toDate === 'function') {
                currentOverrideUntilText.textContent = data.overrideUntil.toDate().toLocaleString();
            } else {
                currentOverrideUntilText.textContent = 'N/A';
            }
        } else {
            currentStatusText.textContent = 'Not found';
            currentDetailsText.textContent = 'N/A';
            currentSourceText.textContent = 'N/A';
            currentLastUpdatedText.textContent = 'N/A';
            currentOverrideUntilText.textContent = 'N/A';
        }
    }, (error) => {
        console.error("Error subscribing to watering status:", error);
        currentStatusText.textContent = 'Error loading realtime';
        displayAdminMessage(`Error listening to status: ${error.message}`, true);
    });
}

setManualStatusButton.addEventListener('click', async () => {
    const status = manualStatusSelect.value;
    const details = manualDetailsInput.value.trim() || `Manual override: ${status}.`;
    const durationDays = parseInt(overrideDurationInput.value);

    if (isNaN(durationDays) || durationDays <= 0) {
        displayAdminMessage("Please enter a valid number of days for the override duration.", true);
        return;
    }

    const now = new Date();
    const overrideEndDate = new Date(now);
    overrideEndDate.setDate(now.getDate() + durationDays);
    overrideEndDate.setHours(18, 0, 0, 0); // 6:00 PM

    const overrideUntilTimestamp = Timestamp.fromDate(overrideEndDate);

    try {
        await setDoc(siteConfigRef, {
            status: status,
            details: details,
            lastUpdated: serverTimestamp(), // Use server timestamp for consistency
            source: 'admin_override',
            overrideUntil: overrideUntilTimestamp
        }, { merge: true }); // Merge to not overwrite other potential fields in site_config
        displayAdminMessage(`Manual status set to "${status}". Will be effective until ${overrideEndDate.toLocaleString()}.`, false);
        manualDetailsInput.value = ''; // Clear input
    } catch (error) {
        console.error("Error setting manual status:", error);
        displayAdminMessage(`Error setting status: ${error.message}`, true);
    }
});

revertToAutoButton.addEventListener('click', async () => {
    try {
        // Step 1: Set initial pending status for immediate UI feedback via onSnapshot
        await updateDoc(siteConfigRef, {
            status: 'Pending Automated Update',
            details: 'The system is fetching the latest status from the automated source.',
            source: 'automation_requested', // This signals the system (and shared logic) to re-evaluate
            overrideUntil: deleteField(), 
            lastUpdated: serverTimestamp()
        });
        displayAdminMessage("Reverted: System is now determining final status...", false);

        // Step 2: Call the shared logic to determine and set the final status.
        // The shared function will handle all fetching, priority logic, and the final setDoc to watering_alert.
        // The onSnapshot listener in this file (admin.js) will then pick up that final update.
        console.log("Admin: Calling shared determineOverallWateringStatus...");
        // We pass the necessary Firebase SDK components to the shared function.
        await determineOverallWateringStatus(db, Timestamp, doc, getDoc, setDoc);
        console.log("Admin: Shared determineOverallWateringStatus finished. Listener should reflect final state.");

    } catch (error) {
        console.error("Error in revertToAutoButton process:", error);
        displayAdminMessage(`Error reverting: ${error.message}`, true);
    }
});

function displayAdminMessage(message, isError = false) {
    adminMessage.textContent = message;
    adminMessage.style.color = isError ? 'red' : 'green';
    adminMessage.classList.remove('hidden');
    setTimeout(() => {
        adminMessage.classList.add('hidden');
        adminMessage.textContent = '';
    }, 5000);
}

function clearAdminMessage() {
    adminMessage.classList.add('hidden');
    adminMessage.textContent = '';
} 