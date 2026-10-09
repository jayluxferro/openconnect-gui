// Masks session material in text before it reaches the Logs tab.
// The Logs tab has a Copy button and bug reports ask for log lines, so
// anything that could let someone resume a VPN session must not appear.

const REDACTED = '<redacted>';

// Header values, anywhere in a line: error messages quote headers too.
// [ \t] around the colon, not \s: \s also matches the newline, which let a
// line ending in "authorization:" swallow and mask the next line.
const SECRET_HEADER = /\b((?:set-cookie2|set-cookie|cookie2|cookie|authorization|proxy-authorization)[ \t]*:[ \t]*)[^\r\n]*/gi;

// Session cookie names used by the protocols openconnect supports:
// AnyConnect (webvpn*), Juniper and Pulse (DS*), GlobalProtect, F5, Fortinet, Array.
const TOKEN_NAMES = [
  'webvpn[a-z0-9_-]*',
  'DSID', 'DSPREAUTH', 'DSSIGNIN', 'DSSignInURL',
  'authcookie', 'portal-userauthcookie', 'portal-prelogonuserauthcookie',
  'MRHSession', 'F5_ST', 'SVPNCOOKIE', 'ANsession',
  'prelogin-cookie', 'session-token', 'cookie',
];
// The value runs to `;` or whitespace. Not `&`: webvpnc values contain it
// (`bu:/&p:t&iu:1/&sh:...`), so stopping there would show the rest.
const TOKEN = new RegExp(`\\b(${TOKEN_NAMES.join('|')})(\\s*=\\s*)(['"]?)[^;\\s'"]*\\3`, 'gi');

// XML bodies, e.g. <authcookie>value</authcookie>
const XML_TOKEN = new RegExp(`<(${TOKEN_NAMES.join('|')})>[^<]*</\\1>`, 'gi');

// Free text such as "Got new DSPREAUTH cookie from TNCC: <value>".
const COOKIE_PHRASE = /\b(cookie\b[^:\r\n]{0,40}:\s*)\S+/gi;

// Auth material under names that are not cookies: passwords, tokens,
// secrets and session ids, in header form ("Password: x") or assignment
// form ("session_id=x"). Header form masks to end of line (there is no
// attribute convention to preserve); assignment form masks one value, so
// query strings keep their other parameters readable.
const GENERIC_SECRET_NAMES = 'password|passwd|passcode|secret|token|session[_-]?id|sessionid';
// [ \t], never \s, around the separator: \s also matches the newline, which
// would let a line ending in "Password:" swallow and mask the next line.
const GENERIC_SECRET_HEADER = new RegExp(`\\b((?:${GENERIC_SECRET_NAMES})[ \\t]*:[ \\t]*)[^\\r\\n]+`, 'gi');
const GENERIC_SECRET_ASSIGN = new RegExp(`\\b((?:${GENERIC_SECRET_NAMES})[ \\t]*=[ \\t]*)(?:"[^"]*"|'[^']*'|[^\\s;&]+)`, 'gi');

// Credentials embedded in a URL: https://user:password@host. Runs to the last
// @ in the URL, since a password may itself contain / or @.
const URL_USERINFO = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s@]*(?:@[^\s@]*)*@/gi;

function redactLog(text) {
  const value = text == null ? '' : String(text);
  return value
    .replace(SECRET_HEADER, `$1${REDACTED}`)
    .replace(COOKIE_PHRASE, `$1${REDACTED}`)
    .replace(TOKEN, `$1$2$3${REDACTED}$3`)
    .replace(XML_TOKEN, `<$1>${REDACTED}</$1>`)
    .replace(GENERIC_SECRET_HEADER, `$1${REDACTED}`)
    .replace(GENERIC_SECRET_ASSIGN, `$1${REDACTED}`)
    .replace(URL_USERINFO, `$1${REDACTED}@`);
}

module.exports = { redactLog };
