function doGet(e) {
  try {
    var today = new Date();
    var dayOffsets = [-4, -3, -2, -1, 0, 1, 2];

    var leagueConfigs = [
      { shortcut: "bl1", seasons: [2026, 2025], label: "Bundesliga", region: "Deutschland" },
      { shortcut: "bl2", seasons: [2026, 2025], label: "2. Bundesliga", region: "Deutschland" },
      { shortcut: "bl3", seasons: [2026, 2025], label: "3. Liga", region: "Deutschland" },
      { shortcut: "dfb", seasons: [2026, 2025], label: "DFB-Pokal", region: "Deutschland" },
      { shortcut: "ucl", seasons: [2026, 2025], label: "Champions League", region: "Europa" },
      { shortcut: "wm26", seasons: [2026], label: "WM 2026", region: "International" }
    ];

    var allMatches = [];
    var seen = {};

    for (var l = 0; l < leagueConfigs.length; l++) {
      var league = leagueConfigs[l];

      for (var s = 0; s < league.seasons.length; s++) {
        var season = league.seasons[s];
        var matches = fetchLeagueMatches_(league.shortcut, season);
        if (!matches.length) continue;

        for (var i = 0; i < matches.length; i++) {
          var match = matches[i] || {};
          var matchDate = parseMatchDate_(match);
          if (!matchDate) continue;

          var dateKey = formatDateKey_(matchDate);
          if (!isDateInOffsets_(today, dateKey, dayOffsets)) continue;

          var home = safe_(match.team1 && match.team1.teamName);
          var away = safe_(match.team2 && match.team2.teamName);
          if (!home || !away) continue;

          var competition = safe_(match.leagueName) || league.label;
          var region = league.region || regionFromLeague_(competition, league.shortcut);

          var key = [
            league.shortcut,
            season,
            competition,
            home,
            away,
            safe_(match.matchDateTimeUTC || match.matchDateTime)
          ].join("|");

          if (seen[key]) continue;
          seen[key] = true;

          var result = extractResult_(match);
          var halftime = extractHalftimeResult_(match);
          var statusText = buildStatusText_(match, result);
          var goals = extractGoals_(match);

          allMatches.push({
            match_id: match.matchID != null ? Number(match.matchID) : "",
            home: home,
            away: away,
            home_team_id: match.team1 && match.team1.teamId != null ? Number(match.team1.teamId) : "",
            away_team_id: match.team2 && match.team2.teamId != null ? Number(match.team2.teamId) : "",
            home_score: result.home_score,
            away_score: result.away_score,
            halftime_home_score: halftime.home_score,
            halftime_away_score: halftime.away_score,
            status: statusText,
            status_text: statusText,
            start_time: toIsoLike_(match.matchDateTimeUTC || match.matchDateTime),
            match_time: toIsoLike_(match.matchDateTimeUTC || match.matchDateTime),
            date_start: toIsoLike_(match.matchDateTimeUTC || match.matchDateTime),
            date_key: dateKey,
            competition: competition,
            competitionLabel: competition,
            matchday: safe_(match.group && match.group.groupName),
            region: region,
            home_logo: safe_(match.team1 && match.team1.teamIconUrl),
            away_logo: safe_(match.team2 && match.team2.teamIconUrl),
            goals: goals,
            url: ""
          });
        }
      }
    }

    allMatches.sort(function(a, b) {
      var ta = Date.parse(a.start_time || "") || 0;
      var tb = Date.parse(b.start_time || "") || 0;
      return ta - tb;
    });

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        source: "openligadb",
        updated: new Date().toISOString(),
        count: allMatches.length,
        matches: allMatches
      }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService
      .createTextOutput(JSON.stringify({
        ok: false,
        source: "openligadb",
        error: String(error)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function fetchLeagueMatches_(shortcut, season) {
  var url = "https://api.openligadb.de/getmatchdata/"
    + encodeURIComponent(shortcut)
    + "/"
    + encodeURIComponent(String(season));

  var response = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "User-Agent": "Mozilla/5.0"
    }
  });

  var status = response.getResponseCode();
  if (status < 200 || status >= 300) return [];

  var text = response.getContentText();
  var json = JSON.parse(text);
  return Array.isArray(json) ? json : [];
}

function parseMatchDate_(match) {
  var raw = safe_(match.matchDateTimeUTC || match.matchDateTime);
  if (!raw) return null;
  var d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function extractResult_(match) {
  var liveGoalScore = extractLatestGoalScore_(match);
  if (liveGoalScore) {
    return liveGoalScore;
  }

  var results = Array.isArray(match.matchResults) ? match.matchResults : [];
  var best = null;

  for (var i = 0; i < results.length; i++) {
    var r = results[i] || {};
    if (!best || Number(r.resultOrderID || 0) > Number(best.resultOrderID || 0)) {
      best = r;
    }
  }

  return {
    home_score: best && best.pointsTeam1 != null ? Number(best.pointsTeam1) : "",
    away_score: best && best.pointsTeam2 != null ? Number(best.pointsTeam2) : ""
  };
}

function extractLatestGoalScore_(match) {
  var goals = Array.isArray(match && match.goals) ? match.goals.slice() : [];
  if (!goals.length) return null;

  goals.sort(function(a, b) {
    var ma = Number(a && a.matchMinute != null ? a.matchMinute : -1);
    var mb = Number(b && b.matchMinute != null ? b.matchMinute : -1);
    if (ma !== mb) return ma - mb;
    return Number(a && a.goalID != null ? a.goalID : 0) - Number(b && b.goalID != null ? b.goalID : 0);
  });

  var last = goals[goals.length - 1] || {};
  var hasHome = last.scoreTeam1 != null && last.scoreTeam1 !== "";
  var hasAway = last.scoreTeam2 != null && last.scoreTeam2 !== "";
  if (!hasHome && !hasAway) return null;

  return {
    home_score: hasHome ? Number(last.scoreTeam1) : "",
    away_score: hasAway ? Number(last.scoreTeam2) : ""
  };
}

function extractHalftimeResult_(match) {
  var results = Array.isArray(match.matchResults) ? match.matchResults : [];

  for (var i = 0; i < results.length; i++) {
    var r = results[i] || {};
    var kind = safe_(r.resultTypeKind).toLowerCase();
    var name = safe_(r.resultName).toLowerCase();
    if (kind === "halftime" || name.indexOf("halbzeit") > -1) {
      return {
        home_score: r.pointsTeam1 != null ? Number(r.pointsTeam1) : "",
        away_score: r.pointsTeam2 != null ? Number(r.pointsTeam2) : ""
      };
    }
  }

  return {
    home_score: "",
    away_score: ""
  };
}

function extractGoals_(match) {
  var goals = Array.isArray(match.goals) ? match.goals : [];
  var out = [];
  var homeTeamId = match.team1 && match.team1.teamId != null ? Number(match.team1.teamId) : null;
  var awayTeamId = match.team2 && match.team2.teamId != null ? Number(match.team2.teamId) : null;

  for (var i = 0; i < goals.length; i++) {
    var g = goals[i] || {};
    var scoringTeamId = g.scoringTeamId != null ? Number(g.scoringTeamId) : null;
    var side = "";
    if (homeTeamId != null && scoringTeamId === homeTeamId) side = "home";
    else if (awayTeamId != null && scoringTeamId === awayTeamId) side = "away";

    out.push({
      goal_id: g.goalID != null ? Number(g.goalID) : "",
      minute: g.matchMinute != null ? Number(g.matchMinute) : "",
      scorer: safe_(g.goalGetterName),
      scorer_id: g.goalGetterID != null ? Number(g.goalGetterID) : "",
      team_id: scoringTeamId != null ? scoringTeamId : "",
      side: side,
      score_home: g.scoreTeam1 != null ? Number(g.scoreTeam1) : "",
      score_away: g.scoreTeam2 != null ? Number(g.scoreTeam2) : "",
      is_penalty: !!g.isPenalty,
      is_own_goal: !!g.isOwnGoal,
      is_overtime: !!g.isOvertime,
      comment: safe_(g.comment)
    });
  }

  out.sort(function(a, b) {
    var ma = Number(a.minute || 0);
    var mb = Number(b.minute || 0);
    if (ma !== mb) return ma - mb;
    return Number(a.goal_id || 0) - Number(b.goal_id || 0);
  });

  return out;
}

function buildStatusText_(match, result) {
  if (match && match.matchIsFinished) return "Beendet";

  var goals = Array.isArray(match && match.goals) ? match.goals : [];
  var hasLiveGoals = goals.length > 0;
  var hasRunningResult = result.home_score !== "" || result.away_score !== "";
  var hasStarted = hasMatchStarted_(match);
  var hasNotStarted = hasMatchNotStarted_(match);
  var halftime = extractHalftimeResult_(match);

  if ((hasLiveGoals || hasRunningResult) && hasStarted) {
    if (isHalftimeState_(match, result, halftime)) return "Halbzeit";
    return buildLiveMinuteLabel_(match);
  }

  if (hasNotStarted) return "Geplant";
  return "Geplant";
}

function hasMatchStarted_(match) {
  var d = parseMatchDate_(match);
  if (!d) return false;
  return d.getTime() <= Date.now();
}

function hasMatchNotStarted_(match) {
  var d = parseMatchDate_(match);
  if (!d) return true;
  return d.getTime() > Date.now();
}

function isHalftimeState_(match, result, halftime) {
  if (!match || !result || !halftime) return false;
  if (result.home_score === "" || result.away_score === "") return false;
  if (halftime.home_score === "" || halftime.away_score === "") return false;
  if (Number(result.home_score) !== Number(halftime.home_score)) return false;
  if (Number(result.away_score) !== Number(halftime.away_score)) return false;

  var d = parseMatchDate_(match);
  if (!d) return false;
  var elapsed = Math.floor((Date.now() - d.getTime()) / 60000);
  if (!isFinite(elapsed) || elapsed < 45 || elapsed > 70) return false;

  var goals = Array.isArray(match.goals) ? match.goals : [];
  for (var i = 0; i < goals.length; i++) {
    var minute = Number(goals[i] && goals[i].matchMinute);
    if (isFinite(minute) && minute > 45) return false;
  }
  return true;
}

function buildLiveMinuteLabel_(match) {
  var d = parseMatchDate_(match);
  if (!d) return "LIVE";

  var elapsed = Math.floor((Date.now() - d.getTime()) / 60000);
  if (!isFinite(elapsed) || elapsed < 1) return "LIVE";

  if (elapsed <= 45) return String(elapsed) + "'";
  if (elapsed < 60) return "45+" + String(elapsed - 45) + "'";
  if (elapsed <= 90) return String(elapsed - 15) + "'";
  if (elapsed < 105) return "90+" + String(elapsed - 90) + "'";
  if (elapsed <= 120) return String(elapsed - 15) + "'";

  return "LIVE";
}

function isDateInOffsets_(today, dateKey, offsets) {
  for (var i = 0; i < offsets.length; i++) {
    var d = addDays_(today, offsets[i]);
    if (formatDateKey_(d) === dateKey) return true;
  }
  return false;
}

function addDays_(date, days) {
  var d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateKey_(d) {
  return d.getFullYear() + "-" + pad2_(d.getMonth() + 1) + "-" + pad2_(d.getDate());
}

function pad2_(n) {
  return n < 10 ? "0" + n : String(n);
}

function safe_(v) {
  return v == null ? "" : String(v).trim();
}

function toIsoLike_(raw) {
  var s = safe_(raw);
  if (!s) return "";
  var d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toISOString().slice(0, 19);
}

function regionFromLeague_(competition, shortcut) {
  var s = String(shortcut || "").toLowerCase();
  var c = String(competition || "").toLowerCase();

  if (s.indexOf("bl") === 0 || s === "dfb") return "Deutschland";
  if (s === "ucl") return "Europa";
  if (s === "wm26") return "International";

  if (c.indexOf("bundesliga") > -1 || c.indexOf("dfb") > -1) return "Deutschland";
  if (c.indexOf("champions") > -1) return "Europa";
  return "International";
}
