/* =====================================================
   main.js - Black IPTV 2026 
   Stabile & Unbegrenzte Fernbedienungs-Logik
   =====================================================
*/

var area = "menu"; // Start-Bereich: Hauptmenü
var mIdx = 0;      // Index für das Menü (0=TV, 1=Filme, 2=Serien, 3=Einstellung)
var sIdx = 1;      // Index für die Buttons im Setup/Einstellung

// Kurze Hilfsfunktion für Element-IDs
function $(id) { return document.getElementById(id); }

/**
 * Aktualisiert die optische Hervorhebung (Fokus) auf dem Bildschirm
 */
function update() {
    // Entferne zuerst alle alten Fokus-Markierungen
    var all = document.querySelectorAll(".item, .btn");
    for (var i = 0; i < all.length; i++) {
        all[i].classList.remove("focused");
    }

    // Zeige die richtige Ansicht basierend auf der Auswahl
    if ($("setup-view") && $("tv-content")) {
        // Nur wenn "Einstellung" (mIdx 3) gewählt ist, zeige das Setup
        $("setup-view").style.display = (mIdx === 3) ? "flex" : "none";
        $("tv-content").style.display = (mIdx === 3) ? "none" : "block";
    }

    // Setze den Fokus neu
    if (area === "menu") {
        var mi = $("i" + mIdx);
        if (mi) mi.classList.add("focused");
    } else {
        var si = $("b" + sIdx);
        if (si) si.classList.add("focused");
    }
}

/**
 * Der Key-Listener: Reagiert auf jeden Tastendruck der Fernbedienung
 */
document.addEventListener("keydown", function(e) {
    var k = e.keyCode;

    // BACK-Taste (Samsung TV Keycode: 10009 oder ESC: 27)
    if (k === 10009 || k === 27) {
        if (area !== "menu") {
            area = "menu"; // Aus dem Setup zurück ins Menü
            update();
            return;
        }
        // Wenn man schon im Menü ist -> App beenden
        try { tizen.application.getCurrentApplication().exit(); } catch (ex) {}
        return;
    }

    // NAVIGATION IM MENÜ (OBEN)
    if (area === "menu") {
        if (k === 37) { // Links
            mIdx = (mIdx > 0) ? mIdx - 1 : 3;
        } else if (k === 39) { // Rechts
            mIdx = (mIdx < 3) ? mIdx + 1 : 0;
        } else if (k === 40 || k === 13) { // Runter oder OK
            if (mIdx === 3) {
                area = "setup";
                sIdx = 1;
            }
        }
    } 
    // NAVIGATION IM SETUP/EINSTELLUNG (UNBEGRENZT)
    else if (area === "setup") {
        if (k === 38) { // Hoch-Taste
            if (sIdx > 1) {
                sIdx--;
            } else {
                area = "menu"; // Ganz oben angekommen -> zurück ins Menü
            }
        }
        else if (k === 40) { // Runter-Taste
            // UNBEGRENZTE LOGIK: Prüfe, ob es ein Element mit der nächsten ID gibt
            var nextBtn = $("b" + (sIdx + 1));
            if (nextBtn) {
                sIdx++;
            }
        }
        else if (k === 13) { // OK-Taste
            // Ruft die Funktion in der index.html auf
            if (typeof window.handleSetupOK === "function") {
                window.handleSetupOK(sIdx);
            }
        }
    }
    update();
});

/**
 * Initialisierung beim Laden der App
 */
window.addEventListener("load", function() {
    // Tizen Tasten registrieren, damit der TV sie nicht für sich selbst nutzt
    try {
        var keys = ["Up", "Down", "Left", "Right", "Enter", "Back"];
        for (var i = 0; i < keys.length; i++) {
            tizen.tvinputdevice.registerKey(keys[i]);
        }
    } catch (e) {
        console.log("Hinweis: Tizen Keys konnten nicht registriert werden (normal im Browser).");
    }
    
    // Ersten Fokus setzen
    update();
});
