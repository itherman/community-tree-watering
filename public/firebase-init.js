// Import the functions you need from the SDKs you need
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-analytics.js";
// Import Auth and Firestore
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.7.1/firebase-firestore.js";

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
    apiKey: "AIzaSyDlj4f86-36VD0bjyfJFdb3ivjTNJhUyH8", //ENSURE THIS IS YOUR KEY
    authDomain: "community-tree-watering.firebaseapp.com",
    projectId: "community-tree-watering",
    storageBucket: "community-tree-watering.appspot.com", // Check if this is correct vs firebasestorage.app
    messagingSenderId: "162527702957",
    appId: "1:162527702957:web:e569b36fd8cd89831f7b24",
    measurementId: "G-2V3S4QGMB4"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app); // Optional

// Initialize Firebase Authentication and Firestore
const auth = getAuth(app);
const db = getFirestore(app);

// Export for use in other scripts, like app.js
export { auth, db, signInAnonymously, analytics }; // also exporting analytics just in case, and signInAnonymously for app.js 