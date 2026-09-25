var CONFIG = {
  SCHEDULE_URL: 'https://pateplayer01.github.io/vnua-calendar/schedule.ics',
  EXAM_URL: 'https://pateplayer01.github.io/vnua-calendar/exams.ics',
  SCHEDULE_CALENDAR_ID: 'vithephat2006@gmail.com',
  EXAM_CALENDAR_ID: 'family10698907130067589119@group.calendar.google.com',
  TAG_UID: 'vnua-uid',
  TIMEZONE: 'Asia/Ho_Chi_Minh',
  COLOR_TOMATO: '11', // Google Calendar colorId chuan: 11 = Tomato (do)
  RED_ROOM_MATCH: 'THT' // phong hoc co chua chuoi nay -> event mau do
};

function sync() {
  checkCalendar(CONFIG.SCHEDULE_CALENDAR_ID, 'Schedule');
  checkCalendar(CONFIG.EXAM_CALENDAR_ID, 'Exam');

  // TKB: it doi trong ky -> gate theo hoc_ky, sync 1 lan cho do ton quota.
  syncICS(CONFIG.SCHEDULE_CALENDAR_ID, CONFIG.SCHEDULE_URL, 'schedule', true);
  // Lich thi: truong cong bo dan tung dot, cung 1 hoc_ky nhung noi dung tang
  // dan -> KHONG gate theo hoc_ky, moi lan chay deu check lai theo UID. Mon
  // thi da co thi giu nguyen (kept), mon thi moi cong bo thi them vao.
  syncICS(CONFIG.EXAM_CALENDAR_ID, CONFIG.EXAM_URL, 'exam', false);
}

function checkCalendar(calId, label) {
  try {
    Calendar.Calendars.get(calId);
  } catch (e) {
    throw new Error(label + ' calendar not found: ' + e.message);
  }
}

// Sync 1 lan / hoc ky: parse xong so X-HOCKY voi properties da luu (rieng
// tung prefix 'schedule'/'exam'). Trung -> return ngay, KHONG goi Calendar
// API. Moi -> insert cai con thieu (theo UID), khong bao gio patch/update
// event cu -> dung yeu cau "chi them, khong thay the".
function syncICS(calId, url, prefix, useHocKyGate) {
  var rawText = fetchICS(url);
  Logger.log(prefix + ' raw length ' + rawText.length);

  var parsed = parseICS(rawText);
  var icsEvents = parsed.events;
  var hocKy = parsed.hocKy;

  if (icsEvents.length === 0) {
    Logger.log(prefix + ' ICS has 0 events - check scraper');
    return;
  }
  Logger.log(prefix + ' ICS has ' + icsEvents.length + ' events, hocKy=' + hocKy);

  var props = PropertiesService.getScriptProperties();
  var propKey = 'synced_hocky_' + prefix;
  var syncedHocKy = props.getProperty(propKey);

  if (useHocKyGate && hocKy && syncedHocKy === hocKy) {
    Logger.log(prefix + ' hoc ky ' + hocKy + ' da sync roi - skip (0 Calendar API call)');
    return;
  }

  var first = icsEvents[0];
  Logger.log('First ' + prefix + ' ' + first.summary + ' ' + first.start + ' ' + first.end);

  var now = new Date();
  var start = new Date(now.getFullYear() - 1, 0, 1);
  var end = new Date(now.getFullYear() + 1, 11, 31);
  // singleEvents:false -> chuoi recurring tra ve 1 master, khong no N instance
  // trung UID (UID gan trong extendedProperties chi nam tren master).
  var existing = listEvents(calId, start, end, false);
  var existingMap = {};

  var i;
  for (i = 0; i < existing.length; i++) {
    var ev = existing[i];
    var uid = getTagValue(ev);
    if (uid) {
      existingMap[uid] = ev;
    }
  }

  Logger.log('Existing VNUA events ' + Object.keys(existingMap).length);

  var created = 0;
  var kept = 0;

  var j;
  for (j = 0; j < icsEvents.length; j++) {
    var ice = icsEvents[j];
    var ev = existingMap[ice.uid];

    if (ev) {
      // Da ton tai (theo UID) -> giu nguyen, khong sua gi ca.
      kept = kept + 1;
      continue;
    }

    var resource = {
      summary: ice.summary,
      location: ice.location,
      description: ice.description,
      start: { dateTime: ice.start.toISOString(), timeZone: CONFIG.TIMEZONE },
      end: { dateTime: ice.end.toISOString(), timeZone: CONFIG.TIMEZONE },
      extendedProperties: { private: {} }
    };
    resource.extendedProperties.private[CONFIG.TAG_UID] = ice.uid;
    if (ice.rrule) {
      // 1 event that lap hang tuan tren Calendar, khong copy N lan thu cong.
      resource.recurrence = [ice.rrule];
    }
    if (ice.location && ice.location.indexOf(CONFIG.RED_ROOM_MATCH) !== -1) {
      resource.colorId = CONFIG.COLOR_TOMATO;
    }

    Calendar.Events.insert(resource, calId);
    created = created + 1;
    Utilities.sleep(200);
    if (created % 30 === 0) {
      Utilities.sleep(3000);
      Logger.log('Pause after ' + created);
    }
  }

  Logger.log(prefix + ' done ' + created + ' created ' + kept + ' kept (already existed)');

  if (hocKy) {
    props.setProperty(propKey, hocKy);
    Logger.log(prefix + ' danh dau hoc ky ' + hocKy + ' da sync');
  }
}

// Xoa dau danh dau da-sync cho 1 hoc ky, de test/re-run syncICS() lai.
// KHONG dong cham gi den event da tao tren Calendar - chi xoa cai nho.
function resetSyncedHistory(prefix) {
  PropertiesService.getScriptProperties().deleteProperty('synced_hocky_' + prefix);
  Logger.log('Da xoa synced_hocky_' + prefix + ' - lan sync() ke tiep se chay lai tu dau');
}

// Nut Run trong editor KHONG cho nhap tham so - goi thang resetSyncedHistory()
// se chay voi prefix=undefined, xoa nham key. Dung 2 ham duoi day, chon thang
// trong dropdown Run thay vi resetSyncedHistory.
function resetScheduleHistory() {
  resetSyncedHistory('schedule');
}

function resetExamHistory() {
  resetSyncedHistory('exam');
}

// Xem hien tai property dang luu hoc ky nao cho tung prefix - chay ham nay
// truoc khi nghi "sao no bao da sync roi" de biet chinh xac key nao dang chan.
function checkSyncedHistory() {
  var props = PropertiesService.getScriptProperties();
  Logger.log('synced_hocky_schedule = ' + props.getProperty('synced_hocky_schedule'));
  Logger.log('synced_hocky_exam = ' + props.getProperty('synced_hocky_exam'));
}

function getTagValue(ev) {
  if (ev.extendedProperties && ev.extendedProperties.private) {
    return ev.extendedProperties.private[CONFIG.TAG_UID];
  }
  return null;
}

function listEvents(calId, start, end, singleEvents) {
  var events = [];
  var pageToken = null;
  do {
    var resp = Calendar.Events.list(calId, {
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      maxResults: 2500,
      singleEvents: singleEvents,
      pageToken: pageToken
    });
    if (resp.items) events = events.concat(resp.items);
    pageToken = resp.nextPageToken;
  } while (pageToken);
  return events;
}

function fetchICS(url) {
  var fullUrl = url + '?v=' + new Date().getTime();
  var resp = UrlFetchApp.fetch(fullUrl, {muteHttpExceptions: true});
  if (resp.getResponseCode() !== 200) {
    Logger.log('Fetch error HTTP ' + resp.getResponseCode());
    return '';
  }
  return resp.getContentText();
}

// Tra ve {hocKy: string|null, events: [...]}. Doc them RRULE (giu nguyen ca
// dong, vd "RRULE:FREQ=WEEKLY;COUNT=6") va X-HOCKY (property cap-calendar,
// nam ngoai moi VEVENT) - ban cu bo qua ca 2 field nay.
function parseICS(text) {
  var rawLines = text.split(String.fromCharCode(10));
  var lines = [];
  var i;
  for (i = 0; i < rawLines.length; i++) {
    var line = rawLines[i];
    if (line.charAt(0) === String.fromCharCode(13)) {
      line = line.substring(1);
    }
    if (line.charAt(line.length - 1) === String.fromCharCode(13)) {
      line = line.substring(0, line.length - 1);
    }

    if (line.length > 0 && (line.charAt(0) === ' ' || line.charAt(0) === String.fromCharCode(9))) {
      if (lines.length > 0) {
        lines[lines.length - 1] = lines[lines.length - 1] + line.substring(1);
      }
    } else {
      lines.push(line);
    }
  }

  var events = [];
  var cur = null;
  var hocKy = null;

  for (i = 0; i < lines.length; i++) {
    var line = lines[i].trim();

    if (line.indexOf('X-HOCKY:') === 0) {
      hocKy = line.substring(8).trim();
    } else if (line === 'BEGIN:VEVENT') {
      cur = {};
      cur.summary = '';
      cur.start = null;
      cur.end = null;
      cur.location = '';
      cur.description = '';
      cur.uid = '';
      cur.rrule = null;
    } else if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start && cur.end) {
        events.push(cur);
      }
      cur = null;
    } else if (cur) {
      if (line.indexOf('UID:') === 0) {
        cur.uid = line.substring(4).trim();
      } else if (line.indexOf('SUMMARY:') === 0) {
        cur.summary = line.substring(8).trim();
      } else if (line.indexOf('LOCATION:') === 0) {
        cur.location = line.substring(9).trim();
      } else if (line.indexOf('DESCRIPTION:') === 0) {
        cur.description = line.substring(12).trim();
      } else if (line.indexOf('DTSTART') === 0) {
        cur.start = parseDT(line);
      } else if (line.indexOf('DTEND') === 0) {
        cur.end = parseDT(line);
      } else if (line.indexOf('RRULE:') === 0) {
        cur.rrule = line;
      }
    }
  }
  return { hocKy: hocKy, events: events };
}

function parseDT(line) {
  var lastColon = line.lastIndexOf(':');
  var val = line.substring(lastColon + 1);
  val = val.trim();
  var y = parseInt(val.substr(0, 4), 10);
  var m = parseInt(val.substr(4, 2), 10) - 1;
  var d = parseInt(val.substr(6, 2), 10);
  var h = parseInt(val.substr(9, 2), 10);
  var min = parseInt(val.substr(11, 2), 10);
  var secStr = val.substr(13, 2);
  var s;
  if (secStr && secStr.length > 0) {
    s = parseInt(secStr, 10);
  } else {
    s = 0;
  }
  return new Date(Date.UTC(y, m, d, h - 7, min, s));
}

function setup() {
  checkCalendar(CONFIG.SCHEDULE_CALENDAR_ID, 'Schedule');
  checkCalendar(CONFIG.EXAM_CALENDAR_ID, 'Exam');
  Logger.log('Schedule OK');
  Logger.log('Exam OK');
}

// Chay 1 LAN de tao trigger tu dong. GitHub Actions (sync.yml) chi refresh
// .ics tren GitHub Pages luc Thu 2, 8h sang (gio VN) - no KHONG goi duoc
// sync() ben Apps Script, 2 he thong tach biet. Trigger nay chay sync()
// luc 9h Thu 2 (sau GH Actions 1 tieng, du thoi gian push + Pages cache).
// Xoa trigger 'sync' cu truoc khi tao, tranh bam chay setupWeeklyTrigger()
// nhieu lan bi nhan trigger.
function setupWeeklyTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var i;
  for (i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sync') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('sync')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .create();
  Logger.log('Da tao trigger: sync() tu chay moi Thu 2 luc 9h (theo timezone cua project script)');
}

function deleteAllTagged() {
  var now = new Date();
  var start = new Date(now.getFullYear() - 1, 0, 1);
  var end = new Date(now.getFullYear() + 1, 11, 31);

  var ev1 = listEvents(CONFIG.SCHEDULE_CALENDAR_ID, start, end, false);
  var ev2 = listEvents(CONFIG.EXAM_CALENDAR_ID, start, end, false);

  var toDelete = [];
  var i;
  for (i = 0; i < ev1.length; i++) {
    if (getTagValue(ev1[i])) toDelete.push({ calId: CONFIG.SCHEDULE_CALENDAR_ID, id: ev1[i].id });
  }
  for (i = 0; i < ev2.length; i++) {
    if (getTagValue(ev2[i])) toDelete.push({ calId: CONFIG.EXAM_CALENDAR_ID, id: ev2[i].id });
  }

  Logger.log('Found ' + toDelete.length + ' VNUA events to delete');

  var deleted = 0;
  var skipped = 0;
  for (i = 0; i < toDelete.length; i++) {
    try {
      Calendar.Events.remove(toDelete[i].calId, toDelete[i].id);
      deleted = deleted + 1;
    } catch (e) {
      // Event da bi xoa tu truoc (410 Resource has been deleted) - bo qua,
      // khong de crash ca vong lap, tiep tuc xoa phan con lai.
      Logger.log('Skip ' + toDelete[i].id + ' (da bi xoa tu truoc): ' + e.message);
      skipped = skipped + 1;
    }
    Utilities.sleep(200);
    if ((deleted + skipped) % 30 === 0) {
      Utilities.sleep(3000);
      Logger.log('Pause cleanup after ' + (deleted + skipped));
    }
  }

  Logger.log('Cleaned ' + deleted + ' events, skipped ' + skipped + ' (already gone)');
}

function cleanup() {
  deleteAllTagged();
}

function cleanOld() {
  deleteAllTagged();
}
