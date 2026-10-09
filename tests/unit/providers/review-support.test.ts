// The rules every reviewer adapter shares (src/main/providers/review-support.ts):
// what failure text and a review's own text keep of a credential, and which
// PATH folders a reviewer's environment keeps.
//
// PURE: strings and synthetic environments in, strings and objects out.
import { describe, it, expect } from 'vitest'
import { redactFailure, redactReply, reviewerEnv } from '../../../src/main/providers/review-support'
import { windowsPathFolderIsFullyQualified } from '../../../src/main/providers/windows-path-names'

describe('failure text hides credentials inside a url', () => {
  const cases: Array<[string, string]> = [
    ['fetch https://alice:s3cretPass@example.com/repo.git failed', 'fetch https://[REDACTED]@example.com/repo.git failed'],
    ['GET http://bob:hunter2@localhost:8080/api -> 401', 'GET http://[REDACTED]@localhost:8080/api -> 401'],
    ['remote: git+ssh://git:tok3nValue@git.example.org/o/r.git', 'remote: git+ssh://[REDACTED]@git.example.org/o/r.git'],
    ['clone https://x7Kq9mZ2pL4vB8nR1tY6uW3e@example.com/o/r', 'clone https://[REDACTED]@example.com/o/r'],
    ['HTTPS://User:Pa55@Example.com', 'HTTPS://[REDACTED]@Example.com'],
    ['https://user:p@ss@example.com/x', 'https://[REDACTED]@example.com/x'],
    // Every character a url's userinfo may hold unencoded, and an encoded one.
    ["https://u:p,a'ss!$&()*+;=@example.com", 'https://[REDACTED]@example.com'],
    ['https://user:pa%40ss@example.com/x', 'https://[REDACTED]@example.com/x'],
    ['https://user:pw@[::1]:8080/', 'https://[REDACTED]@[::1]:8080/'],
    // Characters a url holds only encoded, written raw in a password.
    ['http://svc:Pa^ss{9}@proxy.local:8080', 'http://[REDACTED]@proxy.local:8080'],
    ['https://u:p|w[1]}\\q@example.com/x', 'https://[REDACTED]@example.com/x'],
  ]

  it('the userinfo of an http(s), git+ssh or token-named url is hidden; the scheme and the host stay', () => {
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it("a review's own text hides it the same way", () => {
    for (const [input, want] of cases) expect(redactReply(input), input).toBe(want)
  })

  // A url holds ? and # only encoded; failure text, which can quote a setting
  // as it was typed, also hides a password that holds them raw, after a user
  // name that may hold a raw @, as an e-mail login does.
  const rawDelimiterCases: Array<[string, string]> = [
    ['proxy http://svc:Tq4#Wn8z@proxy.local:8080 refused', 'proxy http://[REDACTED]@proxy.local:8080 refused'],
    ['https://u:Jr2?Lp6#k@example.com/x', 'https://[REDACTED]@example.com/x'],
    ['http://svc:Mv5@Hc#9@proxy.local', 'http://[REDACTED]@proxy.local'],
    ['proxy http://ops@corp.example:Tq4#Wn8z@proxy.local:8080 refused', 'proxy http://[REDACTED]@proxy.local:8080 refused'],
    ['http://ops@corp.example:Mv5@Hc#9@proxy.local', 'http://[REDACTED]@proxy.local'],
  ]

  it('failure text also hides a password written with a raw ? or #, after a user name written with or without an @', () => {
    for (const [input, want] of rawDelimiterCases) expect(redactFailure(input), input).toBe(want)
  })

  it("a review's own text keeps a url whose port is followed by a query or fragment holding an @; failure text hides it up to that @", () => {
    const portCases: Array<[string, string]> = [
      ['GET http://localhost:3000?to=ops@example.com', 'GET http://[REDACTED]@example.com'],
      ['https://h.example:8443#ref@x', 'https://[REDACTED]@x'],
    ]
    for (const [input, want] of portCases) {
      expect(redactReply(input), input).toBe(input)
      expect(redactFailure(input), input).toBe(want)
    }
  })

  // A secret's, a bare session's or a cookie's value is hidden by that
  // field's own rule, so all of it is hidden, and the host is kept.
  it('a secret-named value holding an @ after a port is hidden whole', () => {
    const cases: Array<[string, string]> = [
      ['GET http://svc@api.example:9090?session_id=Kt4@Rw8Hn', 'GET http://[REDACTED]@api.example:9090?session_id=[REDACTED]'],
      ['GET http://dev@team.example@api.example:9090#sessionid=Gm6@Pv3Lc', 'GET http://[REDACTED]@api.example:9090#sessionid=[REDACTED]'],
      ['GET http://svc@api.example:9090?password=Hd&w2@Jx5Tb', 'GET http://[REDACTED]@api.example:9090?password=[REDACTED]'],
      ['GET http://api.example:9090?session_id=Bq9@Ns2Fd', 'GET http://api.example:9090?session_id=[REDACTED]'],
      ['GET http://svc:Pw7@api.example:9090?session_id=Vy3@Lk7Wr', 'GET http://[REDACTED]@api.example:9090?session_id=[REDACTED]'],
      // A colon after the name, a bare session name and a cookie.
      ['GET http://svc@api.example:9090#session_key:Fz6@Tb1Kp', 'GET http://[REDACTED]@api.example:9090#session_key:[REDACTED]'],
      ['GET http://svc@api.example:9090?session=Ct5@Mh2Zx', 'GET http://[REDACTED]@api.example:9090?session=[REDACTED]'],
      ['GET http://svc@api.example:9090?cookie=Dr8@Qe4Ws', 'GET http://[REDACTED]@api.example:9090?cookie=[REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it('a secret-named value holding an @ straight after the host is hidden whole; the host stays', () => {
    const cases: Array<[string, string]> = [
      ['GET https://api.example;session:Rk4@Wd2Lp', 'GET https://api.example;session:[REDACTED]'],
      ['GET http://api.example:9090&session_id=Mz3@Hc7Nq', 'GET http://api.example:9090&session_id=[REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it('a url whose userinfo runs on past a named value to a later @ is hidden up to that @', () => {
    const cases: Array<[string, string]> = [
      ['GET http://svc:Pw7@api.example:9090?session_id=Yb5,Gx8@Tn4Dm', 'GET http://[REDACTED]@Tn4Dm'],
      ['GET http://svc&session_id=Qa2,Wm6@api.example', 'GET http://[REDACTED]@api.example'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it('a credential written as the value of a secret-named field is hidden whole', () => {
    const cases: Array<[string, string]> = [
      ['session_id=https://svc:Wq2,Hn5@api.example/x', 'session_id=[REDACTED]'],
      ['session_key=https://Vt6,Lp2@api.example', 'session_key=[REDACTED]'],
      ['session=https://svc:Jm3;Xc8@api.example', 'session=[REDACTED]'],
      ['session_key: Bearer Jc4Tn8Lw2Pz6Rk1M', 'session_key: [REDACTED] [REDACTED]'],
      ['sessionid=-----BEGIN PRIVATE KEY-----\nmumblemumble\n-----END PRIVATE KEY-----', 'sessionid=[REDACTED]'],
      ['session_id=Cookie: sid=Gv7Hd3', 'session_id=[REDACTED] [REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  // A field starts after a ?, #, &, ; or comma; a session or cookie name
  // anywhere else in a user name or a password is part of that credential.
  it('a user name or password that holds a session or cookie field is hidden whole, and the host stays', () => {
    const cases: Array<[string, string]> = [
      ['push https://ci:Vb4session=Tr8@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://ci:Hm3sessionid:Zp6@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://ci:Gw2session_key=Yc5@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://ci:Qd7-cookie=Lx2@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://ci:Jn4.cookie=Ws9@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://Fy2session=Pc9Wm@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://dev@corp.example:Nu6session=Bk3@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
      ['push https://ci:Rt5;x!Mq2session=Hd7@git.example/team/app.git rejected', 'push https://[REDACTED]@git.example/team/app.git rejected'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it('a field whose name has a prefix, or that follows a comma, is hidden whole after a port; the host stays', () => {
    const cases: Array<[string, string]> = [
      ['GET http://svc@api.example:9090?user_session_id=Wd3@Kp8Zr', 'GET http://[REDACTED]@api.example:9090?user_session_id=[REDACTED]'],
      ['GET http://api.example:9090#app.session_key=Cv5@Rm1Ty', 'GET http://api.example:9090#app.session_key=[REDACTED]'],
      ['GET http://api.example:9090?x=1,session_key=Ht6@Mb2Qv', 'GET http://api.example:9090?x=1,session_key=[REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it('an @ outside a url userinfo is left alone: a query string or fragment (a colon before the @ too), a path, mailto, an scp-style remote and a word after the url', () => {
    for (const s of ['see https://example.com/search?q=a@b.com&x=1', 'https://registry.example.com/@scope/pkg', 'https://registry.example.org:443/@scope/pkg', 'https://en.example.org/wiki/Special:Search?q=a@b.com', 'mailto:someone@example.com', 'git@github.com:o/r.git', 'file:///home/u@x/f', 'https://example.com#frag@x', 'GET https://example.com?at=10:30&to=ops@example.com', 'see https://example.com#L10:20@x', 'see https://k.example then m:n@p']) {
      expect(redactFailure(s), s).toBe(s)
      expect(redactReply(s), s).toBe(s)
    }
  })

  it('quoted lists and markup around a url keep their text: a match never runs across a double quote, an angle bracket or a backtick', () => {
    for (const s of ['["https://a.example.com","ops@example.com"]', '{"url":"https://h.example","owner":"o@x.org"}', '[docs](https://example.com)<ops@example.com>', 'x = `https://example.com`+`a@b`', '["https://a.example.com:443","ops@example.com"]', '[docs](https://example.com:8080)<ops@example.com>', 'x = `https://example.com:8080`+`a@b`', '["https://k.example","m:n@p"]', '<https://k.example>m:n@p', 'x = `https://k.example`m:n@p']) {
      expect(redactFailure(s), s).toBe(s)
      expect(redactReply(s), s).toBe(s)
    }
  })
})

describe('failure text hides a session value', () => {
  it('session and cookie values are hidden, keyed with = or :', () => {
    const cases: Array<[string, string]> = [
      ['request failed: session=Hq3vT8wZ2nK5pL0rX7yB4mC9', 'request failed: session=[REDACTED]'],
      ['session_id: 0f3a9c77 rejected', 'session_id: [REDACTED] rejected'],
      ['{"session": "opaque-session-value"}', '{"session": [REDACTED]}'],
      ['Cookie: sid=abc123; theme=dark', 'Cookie: [REDACTED]'],
      ['set-cookie: __Secure-sess=v1.abc; Path=/; HttpOnly\nnext line', 'set-cookie: [REDACTED]\nnext line'],
      // An aligned column: up to 64 spaces or tabs on either side of the colon.
      ['Cookie' + ' '.repeat(20) + ': sid=abc123; theme=dark', 'Cookie' + ' '.repeat(20) + ': [REDACTED]'],
      ['Cookie:' + ' '.repeat(20) + 'sid=abc123', 'Cookie:' + ' '.repeat(20) + '[REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it('a bare session name hides a quoted or token-shaped value only; words after it are kept, and it never reaches the next line', () => {
    const cases: Array<[string, string]> = [
      // 24 characters or more with no digit is token-shaped too.
      ['session: XkPqRvTwYzAbCdEfGhJkLmNoPqRs', 'session: [REDACTED]'],
      ['Session=abc123; theme=dark', 'Session=[REDACTED]; theme=dark'],
      ['"session":"plain"', '"session":[REDACTED]'],
      // An aligned column: up to 64 spaces or tabs on either side of the colon.
      ['session:' + ' '.repeat(20) + 'Hq3vT8wZ2nK5pL0rX7yB4mC9', 'session:' + ' '.repeat(20) + '[REDACTED]'],
      ['Session' + ' '.repeat(20) + ': Hq3vT8wZ2nK5pL0rX7yB4mC9', 'Session' + ' '.repeat(20) + ': [REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
    for (const prose of ['Breaks resume session: the --resume flag', 'session = null', 'Session: resume picker changed', 'session:\nnext line', 'session:\n42 files changed', 'the session: closed', 'session:' + ' '.repeat(20) + 'closed']) {
      expect(redactFailure(prose), JSON.stringify(prose)).toBe(prose)
    }
  })

  it('a token introduced by words and spaces is hidden; ordinary words after those words are not', () => {
    const cases: Array<[string, string]> = [
      ['sign-in failed: refresh token R7x9Kq2LmP4vN8tB3yW6zC1d', 'sign-in failed: refresh token [REDACTED]'],
      ['Access Token abcdefgh12345678 was refused', 'Access Token [REDACTED] was refused'],
      ['session token XkPqRvTwYzAbCdEfGhJkLmNoPqRs', 'session token [REDACTED]'],
      // An aligned column: up to 64 spaces or tabs between the words and the
      // token (any whitespace after Bearer or Basic), kept as they are.
      ['refresh token' + ' '.repeat(20) + 'R7x9Kq2LmP4vN8tB3yW6zC1d', 'refresh token' + ' '.repeat(20) + '[REDACTED]'],
      ['refresh token\t\tR7x9Kq2LmP4vN8tB3yW6zC1d', 'refresh token\t\t[REDACTED]'],
      ['Authorization: Bearer' + ' '.repeat(20) + 'Zt8wQm3RkV6n', 'Authorization: Bearer' + ' '.repeat(20) + '[REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
    for (const prose of ['the refresh token expired', 'refresh token is invalid', 'api key missing', 'the access token was revoked at login', 'refresh token' + ' '.repeat(20) + 'expired']) {
      expect(redactFailure(prose), prose).toBe(prose)
    }
  })

  it('100 KB of near-miss input is redacted in well under the time a run waits', () => {
    const inputs = [
      'https://' + 'u'.repeat(100_000),
      'a://'.repeat(25_000),
      ('x://' + 'y'.repeat(1_000) + ' ').repeat(100),
      'refresh token '.repeat(7_200),
      ('access token ' + 'z'.repeat(23) + ' ').repeat(2_800),
      'session '.repeat(12_500),
      'session='.repeat(12_500),
      'session: '.repeat(11_200),
      '"session":'.repeat(10_000),
      'cookie'.repeat(17_000),
      'set-cookie '.repeat(9_100),
      ('x://' + '{|^['.repeat(255) + ' ').repeat(98),
      ('x://' + 'u'.repeat(255) + ':' + '#?'.repeat(511) + ' ').repeat(78),
      ('x://u:' + 'p'.repeat(1_018) + ' ').repeat(98),
      'a://b:'.repeat(16_700),
      ('session' + ' '.repeat(63) + ':' + ' '.repeat(63) + 'x ').repeat(780),
      ('refresh token' + ' '.repeat(64)).repeat(1_300),
      ('cookie' + ' '.repeat(64)).repeat(1_430),
      // Whitespace around a name, a scheme word or a JSON key.
      'Bearer' + ' '.repeat(100_000),
      'password' + ' \t\n'.repeat(33_000) + 'x',
      '"access_token"' + ' '.repeat(50_000) + ':' + ' '.repeat(50_000) + 'x',
      ('Basic' + '\n'.repeat(992) + 'abc').repeat(100),
    ]
    // Text dense with field names inside urls, at the redaction window's size.
    const fieldDense = [
      ('a.'.repeat(16) + '://' + 'session_'.repeat(31) + ':' + 'session_'.repeat(127) + ' ').repeat(66),
      ('a.'.repeat(16) + '://' + ';session_'.repeat(28) + ':' + ';session_'.repeat(113) + ' ').repeat(66),
    ]
    const bounded = [...inputs.map((s) => [s, 50] as const), ...fieldDense.map((s) => [s, 150] as const)]
    for (const [s, ms] of bounded) {
      let best = Infinity
      for (let i = 0; i < 3; i++) {
        const t = performance.now()
        redactFailure(s)
        redactReply(s)
        best = Math.min(best, performance.now() - t)
      }
      expect(best, s.slice(0, 24)).toBeLessThan(ms)
    }
  })
})

describe('failure text hides a credential after its name', () => {
  const block = (type: string, body: string) => `-----BEGIN ${type}PRIVATE KEY-----\n${body}\n-----END ${type}PRIVATE KEY-----`

  it("a private key block after a secret's name is hidden whole", () => {
    const cases: Array<[string, string]> = [
      ['password: ' + block('', 'Ue7Rk2Vn9Sx4Lt'), 'password: [REDACTED]'],
      ['secret=' + block('ENCRYPTED ', 'Oa3Mz8Yq1Hc6Wd'), 'secret=[REDACTED]'],
      ['token: ' + block('', 'Ib5Nf9Pg2Xr7Jm'), 'token: [REDACTED]'],
      ['api_key:\n' + block('ENCRYPTED ', 'Ey4Tw1Kc8Gv3Bs'), 'api_key:\n[REDACTED]'],
      ['tls_password = ' + block('', 'Ah6Dq2Zj9Ln5Fx'), 'tls_password = [REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  it("a credential after a Bearer or Basic word is hidden after a secret's name", () => {
    const cases: Array<[string, string]> = [
      ['token: Bearer Rf6WkT2nQz8Lx4Pm', 'token: [REDACTED] [REDACTED]'],
      ['password: Basic Zm9vOmJhcjE5OTk=', 'password: [REDACTED] [REDACTED]'],
      ['refresh_token=Bearer Jy3HcV7mKs1Wq9Dn', 'refresh_token=[REDACTED] [REDACTED]'],
      ['secret:\tBasic\tYg5TpL2xNw8Rk4Ce', 'secret:\t[REDACTED]\t[REDACTED]'],
      ["password: 'Basic Fq9Lp3Vn6Tx2'", "password: [REDACTED] [REDACTED]'"],
      ['API_KEY=bearer Wt4Gn8Ld2Hx6Qp', 'API_KEY=[REDACTED] [REDACTED]'],
      // A double-quoted value that runs onto the next line.
      ['session: "Bearer\n  Zp4Tc8Ns1Gw6"', 'session: [REDACTED]\n  [REDACTED]"'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), input).toBe(want)
  })

  // A Bearer or Basic word that ends a line or a field is followed by the next
  // field: that field's own rule hides its value.
  it('a credential after a field that follows a Bearer or Basic word is hidden', () => {
    const cases: Array<[string, string]> = [
      ['token_type: Bearer\nrefresh_token: Hv6Dn1Sx8Kp3Wm', 'token_type: Bearer\nrefresh_token: [REDACTED]'],
      ['token_type: Bearer\naccess_token: Gc2Mf7Rz4Lt9Yb', 'token_type: Bearer\naccess_token: [REDACTED]'],
      ['auth:\n  type: basic\n  password: Nq4Wk8Fj2Zr6', 'auth:\n  type: basic\n  password: [REDACTED]'],
      ['[proxy]\nauth = basic\npassword = Ld7Xs3Bm9Pq5', '[proxy]\nauth = basic\n[REDACTED] = [REDACTED]'],
      ['AUTH_TYPE=basic\nPASSWORD=Tz8!Kw4@Hn2Vr', 'AUTH_TYPE=basic\n[REDACTED][REDACTED]'],
      ['scheme=basic password=Ry3!Bv6Pc9Mj', 'scheme=basic [REDACTED][REDACTED]'],
      ['Basic password=Cx4$Nf7Rt!', 'Basic [REDACTED][REDACTED]'],
      ['mode: Bearer\npassword=Xd2&7Lq', 'mode: Bearer\n[REDACTED][REDACTED]'],
      // A cookie, a session id and a session field.
      ['WWW-Authenticate: Bearer\r\nSet-Cookie: auth=Ks8Vm3Qd6Lw1; Path=/', 'WWW-Authenticate: Bearer\r\nSet-Cookie: [REDACTED]'],
      ['auth: basic\nsession_id: 7c1e4b90fa23', 'auth: basic\nsession_id: [REDACTED]'],
      ['auth: bearer\nx-session: 4f7a2c9e1b', 'auth: bearer\n[REDACTED]: [REDACTED]'],
      // A url's userinfo.
      ['AUTH_SCHEME=Bearer\nDATABASE_URL=postgres://app:Wb7Kd3Zq9@db.internal:5432/app', 'AUTH_SCHEME=Bearer\nDATABASE_URL=postgres://[REDACTED]@db.internal:5432/app'],
      ['http.proxyauthmethod=basic\nhttp.proxy=http://ops:Jt6Rn2Lx8@proxy.local:3128', 'http.proxyauthmethod=basic\nhttp.proxy=http://[REDACTED]@proxy.local:3128'],
      ['Bearer mongodb+srv://svc:Pg4Hz9Cw1@cluster0.example.net/db', 'Bearer mongodb+srv://[REDACTED]@cluster0.example.net/db'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), JSON.stringify(input)).toBe(want)
  })

  // A Bearer or Basic word that is a field's whole value is followed by the
  // next field or url: neither scheme rule reads that field's name or the
  // url's scheme as a credential, so the field's own rule hides its value.
  it('a field or a URL on the line after an empty Bearer or Basic value keeps its value hidden', () => {
    const cases: Array<[string, string]> = [
      ['services:\n  api:\n    environment:\n      SERVICE_TOKEN: Bearer\n      DB_PASSWORD: Wd5!Kx8Lq3', 'services:\n  api:\n    environment:\n      SERVICE_TOKEN: [REDACTED]\n      DB_PASSWORD: [REDACTED]'],
      ['X-Auth-Token: Bearer \r\nX-Api-Key: Tz6Lm2Wq9Hc4', 'X-Auth-Token: [REDACTED] \r\nX-Api-Key: [REDACTED]'],
      ['API_TOKEN=Bearer \nPG_PASSWORD=Rk3@Vn7Wz5', 'API_TOKEN=[REDACTED] \nPG_PASSWORD=[REDACTED]'],
      ['session: Basic\nclient_secret: Fq2Zn8Ls4Wd', 'session: Basic\nclient_secret: [REDACTED]'],
      ['API_TOKEN=Bearer \nDATABASE_URL=postgres://app:Ly9Kc3Tw6@db.internal:5432/app', 'API_TOKEN=[REDACTED] \nDATABASE_URL=postgres://[REDACTED]@db.internal:5432/app'],
      ['secret = Bearer\npassword = Mh4!Zt7Kp', 'secret = [REDACTED]\npassword = [REDACTED]'],
      ['API_TOKEN=Bearer\nDB_PASSWORD= Gx4!Wm8Lt2', 'API_TOKEN=[REDACTED]\nDB_PASSWORD= [REDACTED]'],
      ['token: Basic\nSet-Cookie: sid=Jc5Wn8Rq2Lv; Path=/', 'token: [REDACTED]\nSet-Cookie: [REDACTED]'],
      ['password: bearer\nsession_id: 3e9b7c1a5f20', 'password: [REDACTED]\nsession_id: [REDACTED]'],
      // A bare session field: a quoted or token-shaped value by its own rule,
      // any other word as before.
      ['token: Bearer\nsession=Pq8!Lt3Zw6', 'token: [REDACTED]\nsession=[REDACTED]'],
      ['token: Bearer\nx-session: "Qvx Lmw Wkz"', 'token: [REDACTED]\nx-session: [REDACTED]'],
      ['token: Bearer\nsession=Qkxmrwpzhn', 'token: [REDACTED]\n[REDACTED]'],
      // A url whose userinfo runs past a named value.
      ['AUTH_SCHEME=Bearer\nPROXY=http://svc&session_id=Kd4,Rm8@api.example', 'AUTH_SCHEME=Bearer\nPROXY=http://[REDACTED]@api.example'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), JSON.stringify(input)).toBe(want)
  })

  it('a token in a name-and-value column after a Bearer or Basic word is hidden, and a second pass changes nothing', () => {
    const sp = ' '.repeat(70)
    const cases: Array<[string, string]> = [
      ['token_type     Bearer\naccess_token   Hb3Vq8Ln2Wz6Kt5', 'token_type     Bearer\naccess_token   [REDACTED]'],
      ['token_type\tBearer\nrefresh_token\tMr7Kd2Xw9Lq4Zp8', 'token_type\tBearer\nrefresh_token\t[REDACTED]'],
      ['auth_method    basic\nclient_secret  Tn6Lw3Rq8Zk2Vb7', 'auth_method    basic\nclient_secret  [REDACTED]'],
      ['token_type     Bearer\nid_token       Wkxqpzrmvtbcdfghjnlsqzwx', 'token_type     Bearer\nid_token       [REDACTED]'],
      ['Cookie: theme=dark; mode=bearer\naccess_token    Wf5Kz9Lq2Tn8Rv3', 'Cookie: [REDACTED] bearer\naccess_token    [REDACTED]'],
      ['token: Bearer\naccess_token    Jx8Ln3Wq6Tz2Kd9', 'token: [REDACTED]\naccess_token    [REDACTED]'],
      ['token_type: Bearer\n' + sp + 'refresh_token    Gp2Lm7Wx4Kq9', 'token_type: Bearer\n' + sp + 'refresh_token    [REDACTED]'],
    ]
    for (const [input, want] of cases) {
      expect(redactFailure(input), JSON.stringify(input.slice(0, 40))).toBe(want)
      expect(redactFailure(want), JSON.stringify(want.slice(0, 40))).toBe(want)
    }
  })

  it("a url's user name and password on the line after an empty Bearer or Basic value are hidden up to the longest userinfo the url rules hide", () => {
    const user = 'Hv' + 'k'.repeat(254)
    const password = 'Rq5' + 'z'.repeat(1_017) + 'Lw7T'
    expect(`${user}:${password}`.length).toBe(1_281)
    const input = `API_TOKEN=Bearer \nDATABASE_URL=postgres://${user}:${password}@db.internal:5432/app`
    expect(redactFailure(input)).toBe('API_TOKEN=[REDACTED] \nDATABASE_URL=postgres://[REDACTED]@db.internal:5432/app')
  })

  it("a field on the same line as a secret's empty Bearer or Basic value keeps its value hidden", () => {
    const cases: Array<[string, string[]]> = [
      ['{Token:Bearer Password:Vb5!Kq8Wz}', ['Vb5', 'Kq8Wz']],
      ['token: Bearer Set-Cookie: sid=Gh4Wn7Lq2Xt', ['Gh4Wn7Lq2Xt']],
      // A no-break space before the cookie's value, or before a lone Bearer
      // word with the credential on the next line.
      ['token: Bearer Set-Cookie:\u00a0sid=Vk7Qm3Lx9Tw', ['Vk7Qm3Lx9Tw']],
      ['token: Bearer Set-Cookie:\u00a0Bearer\n  Dn8Rk2Vc6Pj', ['Dn8Rk2Vc6Pj']],
      // A cookie's value that starts with a Bearer word and holds more.
      ['token: Bearer Set-Cookie: Bearer; sid=Jt4Wn9Lq6Zx', ['Jt4Wn9Lq6Zx']],
      ['secret: basic client_secret: "Pd6 Wm3 Zr8"', ['Pd6', 'Wm3', 'Zr8']],
      ['token: Bearer password:;Wq4Zk8Lm', ['Wq4Zk8Lm']],
      ['secret: Basic password:\n  Hq9Wm4Lz7', ['Hq9Wm4Lz7']],
      ['token: Bearer password:\n;Qd5Lx8Wm3Rt', ['Qd5Lx8Wm3Rt']],
    ]
    for (const [input, secrets] of cases) {
      const out = redactFailure(input)
      for (const secret of secrets) expect(out, JSON.stringify(input)).not.toContain(secret)
    }
  })

  // A credential can end in the letters of a field's name. Where that name's
  // own rule has already hidden what follows its colon, or nothing follows
  // that the rule would hide, the run is read as the credential.
  it("after a Bearer or Basic word that is not a secret's own value, a credential on the word's line whose last letters spell a secret's or a cookie's name is hidden before a colon", () => {
    const cases: Array<[string, string[]]> = [
      ['error: invalid bearer qa-relay-token: token expired', ['qa-relay-token']],
      ['Authorization: Bearer preview-secret: rejected', ['preview-secret']],
      ['Basic fallback_password: denied', ['fallback_password']],
      ['Error: request with Bearer Ty6Wq2Pn-cookie: 401 Unauthorized', ['Ty6Wq2Pn-cookie']],
      ['BEARER STAGE_REFRESH_TOKEN: rejected', ['STAGE_REFRESH_TOKEN']],
      ['{"error": "Bearer hub-api-key: expired"}', ['hub-api-key']],
      ['auth Bearer nightly-set-cookie: invalid', ['nightly-set-cookie']],
      ['Proxy-Authorization: basic relay_client_secret\t: denied', ['relay_client_secret']],
      ['Authorization: Bearer sandbox-token: Wx3Kd8Lq5Zp', ['sandbox-token', 'Wx3Kd8Lq5Zp']],
      // A colon followed by nothing its rules would hide, or by a value
      // already hidden.
      ['request failed with Bearer mock-session-token:', ['mock-session-token']],
      ['Bearer edge-relay-token:, retrying', ['edge-relay-token']],
      ['Authorization: Bearer canary-cookie:\n  retry', ['canary-cookie']],
      ['auth Bearer stage-set-cookie' + ' '.repeat(70) + ': invalid', ['stage-set-cookie']],
      ['Authorization: Bearer drill-api-token:\n  retry', ['drill-api-token']],
      ['Bearer tern-relay-session-id: ;expired', ['tern-relay-session-id']],
      ['{auth: Bearer vexa-session_key:}},next', ['vexa-session_key']],
      ['Authorization: Bearer orbit-session_id: ,retry', ['orbit-session_id']],
      ['Authorization: Bearer mesa-client_secret":\n;retry', ['mesa-client_secret']],
      // A cookie's value that is only a Bearer or Basic word, which the
      // cookie rule keeps.
      ['Authorization: Bearer lumen-cookie: Bearer', ['lumen-cookie']],
      ['Authorization: Bearer fjord-cookie: Basic', ['fjord-cookie']],
      ['auth Bearer quay-set-cookie:\tbearer', ['quay-set-cookie']],
      ['Authorization: Bearer cove-cookie: Bearer\u00a0', ['cove-cookie']],
      ['Authorization: Bearer fallow-cookie: Bearer\n  retry', ['fallow-cookie']],
      // After a secret's own Bearer or Basic value too.
      ['password: Basic replay-api-token:', ['replay-api-token']],
      ['token: Bearer brook-cookie: Bearer  ', ['brook-cookie']],
      ['token: Bearer skerry-cookie:\u00a0', ['skerry-cookie']],
    ]
    for (const [input, secrets] of cases) {
      const out = redactFailure(input)
      for (const secret of secrets) expect(out, JSON.stringify(input)).not.toContain(secret)
    }
  })

  it("a Bearer or Basic credential is hidden whole: one that ends in = padding, also where the padding follows a secret's name joined to the letters before it, and one that ends in other letters before a colon or ://", () => {
    const cases: Array<[string, string]> = [
      ['{"Authorization": "Basic HqLmWzKtRvNpXsBdtoken="}', 'HqLmWzKtRvNpXsBd'],
      ['Authorization: Basic GtRwKnZqLpVmXcHbsecret==', 'GtRwKnZqLpVmXcHb'],
      ['Authorization: Basic MzPqWtLkRnVsHdXctoken=\nnext: 1', 'MzPqWtLkRnVsHdXc'],
      ['password: Basic JwKqLmRtZnXpVbHspassword= expired', 'JwKqLmRtZnXpVbHs'],
      ["curl -H 'Authorization: Basic NvXqRtKmLzWpHbJcsession=' https://api.example", 'NvXqRtKmLzWpHbJc'],
      ['Authorization: Bearer Hn4Zq8Lw2Rk6Tm: expired', 'Hn4Zq8Lw2Rk6Tm'],
      ['Authorization: Bearer Pk7Wn3Lx9Qz2Rt://', 'Pk7Wn3Lx9Qz2Rt'],
    ]
    for (const [input, secret] of cases) expect(redactFailure(input), JSON.stringify(input)).not.toContain(secret)
  })

  it("a credential after a Bearer or Basic word that ends a cookie line is hidden; the cookie's own value stays hidden", () => {
    const sp = ' '.repeat(70)
    const cases: Array<[string, string]> = [
      ['Cookie: theme=dark; Authorization: Basic\n' + sp + 'Yn3Kd8Wq5Lr2Tx', 'Cookie: [REDACTED] Basic\n' + sp + '[REDACTED]'],
      ['Set-Cookie: mode=Bearer \t\n  Ht5Vb2Np8Qs4', 'Set-Cookie: [REDACTED] Bearer \t\n  [REDACTED]'],
      // A scheme word joined to the value is part of it.
      ['Cookie: sid=Rb4Tn9-basic', 'Cookie: [REDACTED]'],
      ['Cookie: sid=Rb4Tn9.Bearer', 'Cookie: [REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), JSON.stringify(input.slice(0, 40))).toBe(want)
  })

  it('a value any run of whitespace or lines from its name is hidden; the spacing stays', () => {
    const sp = (n: number) => ' '.repeat(n)
    const cases: Array<[string, string]> = [
      ['Bearer' + sp(65) + 'Wc7Nq2Lp5Tz9Hk', 'Bearer' + sp(65) + '[REDACTED]'],
      ['Authorization: Basic\n' + sp(70) + 'cXVpZXQ6bm9pc2U5', 'Authorization: Basic\n' + sp(70) + '[REDACTED]'],
      ['password:' + sp(65) + 'Fr4&Gm8', 'password:' + sp(65) + '[REDACTED]'],
      ['client_secret =' + '\t'.repeat(80) + 'Pk2&Vd6', 'client_secret =' + '\t'.repeat(80) + '[REDACTED]'],
      ['secret' + '\t'.repeat(70) + ': Qm7&Xc2', 'secret' + '\t'.repeat(70) + ': [REDACTED]'],
      ['api_key:\n' + sp(70) + 'Uz5&Mw3', 'api_key:\n' + sp(70) + '[REDACTED]'],
      ['token:' + sp(65) + 'Lb' + 'n'.repeat(600) + 'Qy3', 'token:' + sp(65) + '[REDACTED]'],
      ['"access_token":' + sp(65) + '"Hx 4 Rn"', '"access_token":' + sp(65) + '[REDACTED]'],
      ['token' + '\t'.repeat(70) + ':' + sp(70) + 'Bearer' + sp(70) + 'Vr5Hk9Jn3Cs7', 'token' + '\t'.repeat(70) + ':' + sp(70) + '[REDACTED]' + sp(70) + '[REDACTED]'],
    ]
    for (const [input, want] of cases) expect(redactFailure(input), JSON.stringify(input.slice(0, 40))).toBe(want)
    // A review's own text hides a quoted JSON credential the same way.
    expect(redactReply('"access_token":' + sp(65) + '"Hx 4 Rn"')).toBe('"access_token":' + sp(65) + '"[REDACTED]"')
    expect(redactReply('"client_secret"' + '\t'.repeat(70) + ': "Tn 6 Wb"')).toBe('"client_secret"' + '\t'.repeat(70) + ': "[REDACTED]"')
  })
})

describe('the PATH a reviewer keeps', () => {
  it('every PATH filter applies the same folder rule: a drive or a share, quoted or not; never a device path, a bare server name or a relative folder', () => {
    const entries = ['C:\\Windows', 'D:/tools', '"C:\\Program Files\\x"', '\\\\srv\\share\\bin', '//srv/share', '\\\\?\\C:\\dev', '\\\\.\\C:\\dev', '//?/C:/dev', '//./pipe/x', '"\\\\?\\C:\\q"', '\\\\srvonly', '\\rooted', '.', 'node_modules\\.bin', 'C:rel', '']
    const env = reviewerEnv({ Path: entries.join(';') }, 'win32')
    expect(env.Path).toBe('C:\\Windows;D:/tools;C:\\Program Files\\x;\\\\srv\\share\\bin;//srv/share')
  })

  it('each folder reaches the reviewer as it was judged: trimmed, and without the quotes around a quoted one', () => {
    const entries = [' C:\\x', '\tD:\\tools', '" C:\\q "', ' \\\\srv\\share\\bin', '"C:\\Program Files\\y" ', '"C:\\a"b"', ' "\\\\?\\C:\\dev" ', '  ', ' . ']
    const env = reviewerEnv({ PATH: entries.join(';') }, 'win32')
    expect(env.PATH).toBe('C:\\x;D:\\tools;C:\\q;\\\\srv\\share\\bin;C:\\Program Files\\y;C:\\a"b')
    // Every kept folder is one the shared rule accepts exactly as it is passed on.
    for (const dir of env.PATH.split(';')) {
      expect(windowsPathFolderIsFullyQualified(dir), dir).toBe(true)
      expect(dir, dir).toBe(dir.trim())
    }
  })

  it('on POSIX only absolute entries stay, as before', () => {
    expect(reviewerEnv({ PATH: '/usr/bin::bin:./x:/opt/b:' }, 'linux').PATH).toBe('/usr/bin:/opt/b')
  })
})
