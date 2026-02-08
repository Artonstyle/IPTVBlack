/* main.js - Stabile Fernbedienungs-Logik für Black IPTV 2026 */

var area = "menu"; // "menu" oder "setup"
var mIdx = 0;      // Menü-Index (0:TV, 1:Filme, 2:Serien, 3:Einstellung)
var sIdx = 1;      // Setup-Index (1-4 für die Buttons)

// Hilfsfunktion für IDs
function $(id) { return document.getElementById(id); }

// Fokus-Update Funktion
function update() {
    // Alle Fokus-Klassen entfernen
    var all = document.querySelectorAll(".item, .btn, .bg-btn");
    for (var i = 0; i < all.length; i++) {
        all[i].classList.remove("focused");
    }

    // Ansichten umschalten (TV vs Setup)
    if ($("setup-view") && $("tv-content")) {
        $("setup-view").style.display = (mIdx === 3) ? "flex" : "none";
        $("tv-content").style.display = (mIdx === 3) ? "none" : "block";
    }

    // Fokus setzen
    if (area === "menu") {
        var mi = $("i" + mIdx);
        if (mi) mi.classList.add("focused");
    } else {
        var si = $("b" + sIdx);
        if (si) si.classList.add("focused");
    }
}

// Tasten registrieren
function registerKeys() {
    try {
        var keys = ["Up", "Down", "Left", "Right", "Enter", "Back"];
        for (var i = 0; i < keys.length; i++) {
            tizen.tvinputdevice.registerKey(keys[i]);
        }
    } catch (e) {
        console.log("Tizen Keys konnten nicht registriert werden.");
    }
}

// Der Key-Listener
document.addEventListener("keydown", function(e) {
    var k = e.keyCode;

    // BACK TASTE (App verlassen oder zurück zum Menü)
    if (k === 10009 || k === 27) {
        if (area !== "menu") {
            area = "menu";
            update();
            return;
        }
        try { tizen.application.getCurrentApplication().exit(); } catch (ex) {}
        return;
    }

    // NAVIGATION IM HAUPTMENÜ
    if (area === "menu") {
        if (k === 37) mIdx = (mIdx > 0) ? mIdx - 1 : 3; // Links
        else if (k === 39) mIdx = (mIdx < 3) ? mIdx + 1 : 0; // Rechts
        else if (k === 40 || k === 13) { // Runter oder OK
            if (mIdx === 3) {
                area = "setup";
                sIdx = 1;
            }
        }
    } 
    // NAVIGATION IM SETUP
    else if (area === "setup") {
        if (k === 38) { // Hoch
            if (sIdx > 1) sIdx--;
            else area = "menu";
        }
        else if (k === 40) { // Down
            if (sIdx < 4) sIdx++;
        }
        else if (k === 37 || k === 39) { // Seitwärts (Spaltenwechsel)
            sIdx = (sIdx <= 3) ? 4 : 1;
        }
        else if (k === 13) { // OK Taste im Setup
            // Hier rufen wir die Funktionen auf, die in der index.html liegen
            if (typeof window.handleSetupOK === "function") {
                window.handleSetupOK(sIdx);
            }
        }
    }
    update();
});

// Start-Initialisierung
window.addEventListener("load", function() {
    registerKeys();
    update();
});
