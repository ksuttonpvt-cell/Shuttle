// Automatic customer text messages through Twilio (https://www.twilio.com).
// Turned on by putting TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM in .env.
// Without them nothing is sent and the rest of the site works as before.

// US numbers: "303-555-1234" -> "+13035551234". Returns null if it can't be a phone number.
function toE164(phone) {
  if (!phone) return null;
  const raw = String(phone).trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

function createTwilioSender({
  sid = process.env.TWILIO_ACCOUNT_SID,
  token = process.env.TWILIO_AUTH_TOKEN,
  from = process.env.TWILIO_FROM,
} = {}) {
  const configured = !!(sid && token && from);
  return {
    configured,
    from: configured ? from : null,
    async send(to, body) {
      if (!configured) throw new Error('Texting is not set up.');
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Twilio error ${res.status}`);
      return data.sid;
    },
  };
}

module.exports = { toE164, createTwilioSender };
