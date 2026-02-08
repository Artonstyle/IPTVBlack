/* =====================================================
   main.js - Black IPTV 2026 Pro
   Navigation für Menü, TV-Listen und Setup
   =====================================================
*/

var area = "menu"; // menu, tv, setup
var mIdx = 0;      // 0:TV, 1:Filme, 2:Serien, 3:Einstellung
var sIdx = 1;      // Setup-Buttons (b1, b2, ...)
var catIdx = 0;    // Index für Kategorien
var chanIdx = 0;   // Index für Sender
var tvCol = 0;     // 0: Kategorien-Spalte, 1: Sender-Spalte

function $(id) { return document.getElementById(id); }

/**
 * Aktualisiert den Fokus und die Sichtbarkeit der Bereiche
 */
function update() {
    // Alle Fokus-Klassen entfernen
    var all = document.querySelectorAll(".item, .btn, .list-item");
    for (var i = 0; i < all.length; i++) { all[i].classList.remove("focused"); }

    // Ansichten schalten (Wird auch in der index.html getriggert)
    if ($("tv-view")) $("tv-view").style.display = (mIdx === 0) ? "flex" : "none";
    if ($("setup-view")) $("setup-view").style.display = (mIdx === 3) ? "flex" : "none";

    // Fokus setzen je nach Bereich
    if (area === "menu") {
        var mi = $("i" + mIdx);
        if (mi) mi.classList.add("focused");
    } 
    else if (area === "setup") {
        var si = $("b" + sIdx);
        if (si) si.classList.add("focused");
    }
    else if (area === "tv") {
        if (tvCol === 0) {
            var cats = document.querySelectorAll("#cat-list .list-item");
            if (cats[catIdx]) cats[catIdx].classList.add("focused");
        } else {
            var chans = document.querySelectorAll("#chan-list .list-item");
            if (chans[chanIdx]) chans[chanIdx].classList.add("focused");
        }
    }
}

/**
 * Tastensteuerung
 */
document.addEventListener("keydown", function(e) {
    var k = e.keyCode;

    // BACK-Taste (Samsung TV oder ESC)
    if (k === 10009 || k === 27) {
        if (area !== "menu") {
            area = "menu";
            update();
            return;
        }
        try { tizen.application.getCurrentApplication().exit(); } catch (ex) {}
        return;
    }

    // 1. HAUPTMENÜ NAVIGATION
    if (area === "menu") {
        if (k === 37) mIdx = (mIdx > 0) ? mIdx - 1 : 3; // Links
        else if (k === 39) mIdx = (mIdx < 3) ? mIdx + 1 : 0; // Rechts
        else if (k === 40 || k === 13) { // Runter oder OK
            if (mIdx === 0) { area = "tv"; tvCol = 0; catIdx = 0; }
            else if (mIdx === 3) { area = "setup"; sIdx = 1; }
        }
    } 
    
    // 2. TV-LISTEN NAVIGATION (Kategorien & Sender)
    else if (area === "tv") {
        if (tvCol === 0) { // In der KATEGORIE-Spalte
            var cats = document.querySelectorAll("#cat-list .list-item");
            if (k === 38) { // Hoch
                if (catIdx > 0) catIdx--;
                else area = "menu";
            }
            else if (k === 40 && catIdx < cats.length - 1) catIdx++; // Runter
            else if (k === 39 || k === 13) { // Rechts oder OK -> Wechsel zu Sendern
                tvCol = 1;
                chanIdx = 0;
            }
        } 
        else if (tvCol === 1) { // In der SENDER-Spalte
            var chans = document.querySelectorAll("#chan-list .list-item");
            if (k === 38 && chanIdx > 0) chanIdx--; // Hoch
            else if (k === 40 && chanIdx < chans.length - 1) chanIdx++; // Runter
            else if (k === 37) tvCol = 0; // Links -> Zurück zu Kategorien
            else if (k === 13) {
                // Hier kommt später der Video-Start hin
                console.log("Sender gewählt: " + chans[chanIdx].innerText);
            }
        }
    }

    // 3. SETUP NAVIGATION
    else if (area === "setup") {
        if (k === 38) { // Hoch
            if (sIdx > 1) sIdx--;
            else area = "menu";
        }
        else if (k === 40) { // Runter
            if ($("b" + (sIdx + 1))) sIdx++;
        }
        else if (k === 13) { // OK
            if (typeof window.handleSetupOK === "function") {
                window.handleSetupOK(sIdx);
            }
        }
    }

    update();
});

/**
 * Initialisierung
 */
window.addEventListener("load", function() {
    try {
        var keys = ["Up", "Down", "Left", "Right", "Enter", "Back"];
        for (var i = 0; i < keys.length; i++) {
            tizen.tvinputdevice.registerKey(keys[i]);
        }
    } catch (e) {}
    update();
});
