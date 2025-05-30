// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-analytics.js";
// Import Auth and Firestore
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js";

let app;

// Check if a local configuration is provided on the window object
if (window.firebaseConfigLocal) {
    app = initializeApp(window.firebaseConfigLocal);
} else {
    // Fallback for production (deployed to Firebase Hosting)
    // This will use the auto-configuration from /__/firebase/init.js on Firebase Hosting
    app = initializeApp();
}

const analytics = getAnalytics(app); // Optional
const auth = getAuth(app);
const db = getFirestore(app);

// Export for use in other scripts, like app.js
export { auth, db, signInAnonymously, analytics }; 