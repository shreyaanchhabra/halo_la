import { $ } from '../../lib/dom'

export function mountTemplates() {
  $('calendar').innerHTML = `
    <h2>Calendar</h2>
    <p class="hint">Plans HALO hears in conversation appear here once the patient says yes, or after you approve them.</p>
    <div id="cal-status"></div>
    <div id="cal-waiting"></div>
    <div id="cal-upcoming"></div>
    <details id="cal-skipped" hidden><summary>Not added (<span id="cal-skipped-count">0</span>)</summary><ul class="list" id="cal-skipped-list"></ul></details>
    <h3>Add an event</h3>
    <form id="cal-add">
      <div class="row">
        <label>What <input name="activity" required placeholder="Dentist appointment" /></label>
        <label>With <input name="who" placeholder="Maya, Paul" /></label>
      </div>
      <div class="row">
        <label>When <input name="start" type="datetime-local" required /></label>
        <label class="check"><input name="allDay" type="checkbox" /> All day</label>
      </div>
      <button type="submit">Add to calendar</button>
      <p class="hint" id="cal-add-error" role="alert"></p>
    </form>
    <h3>Use it in your own calendar</h3>
    <p class="hint">Subscribe once and everything HALO adds shows up in Apple Calendar, Google Calendar or Outlook, with a reminder an hour before.</p>
    <div class="actions">
      <a class="button" id="cal-webcal" href="#">Open in Apple Calendar</a>
      <button type="button" id="cal-copy">Copy feed link</button>
      <span class="hint" id="cal-copied" role="status"></span>
    </div>
    <p class="hint">Google Calendar: Settings → Add calendar → From URL. It needs a link reachable from the internet, so use the copied link once HALO is hosted.</p>`

  $('conversation').innerHTML = `
    <h2>Conversation</h2>
    <p class="hint">What HALO hears from the glasses. Type a sentence here to try it without speaking.</p>
    <form id="say-form" class="say">
      <label>Speaker <select id="say-speaker"></select></label>
      <label>Says <input id="say-text" required autocomplete="off" placeholder="I'll come by Saturday at 2 and we'll go to the park" /></label>
      <button type="submit" id="say-btn">Send</button>
    </form>
    <p class="hint" id="say-result" role="status"></p>
    <ul class="list transcript" id="transcript"></ul>`
}
