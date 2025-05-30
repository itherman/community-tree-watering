// Import Firebase services from firebase-init.js (make sure this path is correct)
import { auth, db } from './firebase-init.js';
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js';
import { doc, getDoc, setDoc, Timestamp, serverTimestamp, updateDoc } from 'https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js';

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

onAuthStateChanged(auth, (user) => {
    if (user && !user.isAnonymous) {
        authContainer.classList.add('hidden');
        adminControls.classList.remove('hidden');
        userEmailDisplay.textContent = user.email;
        loadCurrentWateringStatus();
    } else {
        authContainer.classList.remove('hidden');
        adminControls.classList.add('hidden');
        userEmailDisplay.textContent = '';
        if (user && user.isAnonymous) {
            signOut(auth).catch(err => console.warn("Error signing out anonymous user on admin page:", err));
        }
        clearAdminMessage();
    }
});

// --- Watering Status Management ---
async function loadCurrentWateringStatus() {
    try {
        const docSnap = await getDoc(siteConfigRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            currentStatusText.textContent = data.status || 'N/A';
            currentDetailsText.textContent = data.details || 'N/A';
            currentSourceText.textContent = data.source || 'N/A';
            currentLastUpdatedText.textContent = data.lastUpdated ? data.lastUpdated.toDate().toLocaleString() : 'N/A';
            currentOverrideUntilText.textContent = data.overrideUntil ? data.overrideUntil.toDate().toLocaleString() : 'N/A';
        } else {
            currentStatusText.textContent = 'Not found';
            currentDetailsText.textContent = 'N/A';
            currentSourceText.textContent = 'N/A';
            currentLastUpdatedText.textContent = 'N/A';
            currentOverrideUntilText.textContent = 'N/A';
        }
    } catch (error) {
        console.error("Error loading current status:", error);
        currentStatusText.textContent = 'Error loading';
        displayAdminMessage(`Error loading status: ${error.message}`, true);
    }
}

setManualStatusButton.addEventListener('click', async () => {
    const status = manualStatusSelect.value;
    const details = manualDetailsInput.value.trim() || `Manual override: ${status}.`;
    const durationDays = parseInt(overrideDurationInput.value);

    if (isNaN(durationDays) || durationDays <= 0) {
        displayAdminMessage("Please enter a valid number of days for the override duration.", true);
        return;
    }

    // Calculate overrideUntil: End of the selected day (e.g., Monday 6 PM)
    // For simplicity here, we'll set it to X days from now at 6 PM.
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
        await loadCurrentWateringStatus(); // Refresh display
        manualDetailsInput.value = ''; // Clear input
    } catch (error) {
        console.error("Error setting manual status:", error);
        displayAdminMessage(`Error setting status: ${error.message}`, true);
    }
});

revertToAutoButton.addEventListener('click', async () => {
    try {
        // To revert, we can remove 'overrideUntil' and 'source',
        // or set source to something that indicates it should fetch.
        // Let's remove overrideUntil and set source to 'default_after_override'.
        // The main app.js will then know to treat it as needing a fresh scrape if stale.
        await updateDoc(siteConfigRef, {
            source: 'automation_requested', // Or 'default_after_override'
            overrideUntil: null // Firestore can't store null directly, use deleteField if needed, but null might be fine for logic check
            // Alternatively, to truly remove the field:
            // overrideUntil: firebase.firestore.FieldValue.delete() - requires full SDK or specific import
        });
        // A simpler way that works with modular SDK without needing deleteField directly:
        const currentData = (await getDoc(siteConfigRef)).data() || {};
        delete currentData.overrideUntil; // Remove the key from the object
        currentData.source = 'automation_requested';
        currentData.lastUpdated = serverTimestamp(); // Update timestamp
        await setDoc(siteConfigRef, currentData);


        displayAdminMessage("Reverted to Casey Trees automation. System will fetch new data if current is stale.", false);
        await loadCurrentWateringStatus();
    } catch (error) {
        console.error("Error reverting to auto:", error);
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