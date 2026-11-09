# pdf-esign

가지고 있는 PDF 문서에 내가 먼저 서명하고, 상대방에게 메일 링크로 서명을 받은 뒤,
양쪽이 같은 날인본 PDF를 보관하는 자체 호스팅 전자서명 도구입니다.

- 외부 SaaS 없이 동작합니다. DB는 SQLite(`node:sqlite`), 파일은 로컬 디스크(`data/`)에 저장합니다.
- 메일은 Resend로 발송합니다. 키가 없으면 서명 링크를 화면에 표시하므로 직접 전달하면 됩니다.
- 내 PC에서 쓸 때는 Cloudflare 빠른 터널로 임시 공개 URL을 엽니다.

## 동작 방식

1. 관리자 로그인 후 PDF를 업로드합니다.
2. 편집 화면에서 서명자(나, 상대방)를 추가하고 페이지 위에 서명·이름·날짜·텍스트 필드를 배치합니다. 서명자 순서가 곧 서명 순서입니다.
3. 발송하면 첫 번째 서명자 차례가 됩니다. 내가 첫 번째면 상세 화면의 "지금 서명하기"로 서명합니다.
4. 다음 서명자에게 `APP_URL/sign/<토큰>` 링크가 메일로 갑니다. 상대방은 가입 없이 브라우저에서 서명합니다.
5. 모든 서명이 끝나면 날인본을 만들고 모든 서명자에게 첨부 메일로 보냅니다.

날인본 구성:

- 원본 페이지 위에 서명 이미지와 입력값을 찍습니다.
- 마지막에 감사 추적 페이지를 붙입니다. 원본 SHA-256, 서명자별 이메일·IP·User-Agent·서명 시각, 이벤트 기록이 들어갑니다.
- 전체 파일에 PAdES 디지털 서명을 적용합니다. 서명 후 파일이 바뀌면 Adobe Reader 서명 패널에서 "변경됨"으로 표시됩니다. 인증서는 첫 실행 시 자체 서명으로 생성되어 `data/cert.p12`에 저장됩니다. 그래서 Adobe에는 "신원을 확인할 수 없음"으로 표시되지만 무결성 검증은 동작합니다.

## 요구 사항

- Node.js 22.5 이상 (`node:sqlite` 사용)
- 공개 링크가 필요하면 cloudflared: `winget install Cloudflare.cloudflared`
- 메일 자동 발송이 필요하면 Resend API 키와 Resend에서 인증된 발송 도메인

## 설치

```powershell
npm install
copy .env.example .env.local   # 값 채우기
```

`.env.local` 항목:

| 키 | 설명 |
|---|---|
| `APP_URL` | 메일 링크의 기준 URL. `scripts/start.ps1`을 쓰면 터널 URL로 자동 덮어씁니다 |
| `ADMIN_PASSWORD` | 관리자 로그인 비밀번호. 12자 이상이어야 하며, 바꾸면 기존 로그인 세션이 모두 끊깁니다 |
| `SESSION_SECRET` | 세션 쿠키 서명 키(32자 이상 무작위 문자열) |
| `OWNER_NAME`, `OWNER_EMAIL` | 편집 화면에서 "나" 서명자의 기본값. 내 서명 차례가 되면 이 주소로 관리자 화면 링크가 갑니다 |
| `RESEND_API_KEY` | 선택. 없으면 메일 대신 콘솔과 화면에 링크 표시 |
| `MAIL_FROM` | 발신자. 도메인이 Resend에 인증되어 있어야 합니다. `RESEND_API_KEY`가 있는데 비어 있으면 메일을 보내지 않습니다 |
| `MAIL_DISABLED` | `1`이면 메일을 절대 보내지 않고 콘솔에만 기록합니다(테스트용) |
| `SIGN_OTP` | 서명 전 이메일 본인 확인. `on`(기본) 또는 `off`. 메일을 실제로 보낼 수 있을 때만 적용됩니다(아래 "이메일 본인 확인(OTP)" 참고) |
| `OTP_TEST_MODE` | 테스트 전용. `MAIL_DISABLED=1`과 함께 `1`로 두면 OTP를 요구하되 인증번호를 메일 대신 서버 콘솔에 출력합니다 |
| `TRUST_PROXY` | 클라이언트 IP 출처. `none`(기본, 전달 헤더 무시) 또는 `cloudflare`(`cf-connecting-ip`만 신뢰). `start.ps1`은 터널을 켤 때 `cloudflare`로 설정합니다 |
| `DATA_DIR` | 선택. 데이터 폴더 경로(기본 `./data`) |

## 실행

```powershell
# 프로덕션 빌드 + 공개 터널 (권장)
powershell -ExecutionPolicy Bypass -File scripts/start.ps1

# 개발 서버 + 터널
powershell -ExecutionPolicy Bypass -File scripts/start.ps1 -Dev

# 로컬 전용
npm run dev        # http://localhost:3100
```

- 서버는 `127.0.0.1`에만 바인딩됩니다(같은 PC에서만 직접 접속 가능, 외부 접속은 터널 경유).
- 빠른 터널(`trycloudflare.com`) URL은 실행할 때마다 바뀝니다. 상대방이 서명을 마칠 때까지 PC와 창을 켜 두세요.
- 이미 보낸 메일의 링크는 이전 터널 주소를 가리키므로 재시작 후에는 동작하지 않습니다. 상세 화면의 "알림 재발송"을 누르면
  진행 중 문서는 현재 차례 서명자에게 새 링크를, 완료된 문서는 모든 서명자에게 새 다운로드 링크와 날인본을 다시 보냅니다.
- `npm run tunnel`을 따로 쓸 때는 `TRUST_PROXY=cloudflare`와 `APP_URL`을 직접 설정하세요.

### 고정 주소: 내 도메인으로 이름 있는 터널

주소가 바뀌지 않게 하려면 Cloudflare에 등록된 내 도메인으로 이름 있는 터널을 만듭니다(무료).

```powershell
cloudflared tunnel login                                  # 브라우저에서 도메인 선택
cloudflared tunnel create esign                           # 터널 생성 (자격 증명 파일 생성)
cloudflared tunnel route dns esign sign.example.com       # DNS CNAME 연결
cloudflared tunnel run --url http://127.0.0.1:3100 esign  # 실행
```

`.env.local`에 `APP_URL=https://sign.example.com`, `TRUST_PROXY=cloudflare`를 넣고 `npm start`로 서버를 띄웁니다
(`start.ps1 -NoTunnel`도 가능). 이렇게 하면 서버를 다시 켜도 이미 보낸 링크가 계속 동작합니다.
- 코드를 바꾼 뒤에는 `npm run build`를 다시 실행하세요. `start.ps1`은 빌드 결과가 없을 때만 빌드합니다.

## 이메일 본인 확인(OTP)

서명 링크만 있으면 누구나 서명할 수 있는 문제를 줄이기 위해, 서명자가 "서명 완료"를 누르면 서명 요청을 받은 이메일 주소로 6자리 인증번호를 보내고 이를 입력해야 제출되게 합니다. 화면에는 `hl****@example.com`처럼 가려진 주소만 보이며, 인증에 성공하면 서명이 자동으로 제출됩니다.

서명자가 서명 칸을 처음 누르는 순간 인증번호가 자동으로 발송되어, 서명을 입력하는 동안 메일이 도착합니다. 인증번호는 5분간 유효하고, 하나의 번호에 5번 틀리면 그 번호는 무효가 되어 새로 받아야 합니다. 만료되면 인증 화면에서 다시 받을 수 있습니다. 재발송은 30초 간격으로 가능하며 서명자 한 명당 1시간에 5번까지 보낼 수 있습니다. 인증에 성공하면 30분 안에 서명을 제출해야 하고, 이 시간이 지나면 다시 인증해야 합니다. 서버에는 인증번호 자체가 아니라 HMAC 값만 저장되며, 발송·성공·실패는 IP와 브라우저 정보와 함께 이벤트 기록에 남고, 감사 증명서의 서명자 항목에 "본인 확인: 이메일 OTP 인증 (시각)"으로 표시됩니다.

이 기능은 `SIGN_OTP=on`(기본값)이면서 메일을 실제로 보낼 수 있을 때(`RESEND_API_KEY`와 `MAIL_FROM`이 있고 `MAIL_DISABLED`가 아닐 때)만 적용됩니다. 메일 설정이 없으면 인증 없이 이전처럼 서명할 수 있고, 서명 화면 API 응답의 `otp.required`가 `false`가 됩니다. 끄려면 `SIGN_OTP=off`로 설정하세요.

테스트할 때는 `MAIL_DISABLED=1`과 `OTP_TEST_MODE=1`을 함께 설정하면 메일을 보내지 않으면서도 OTP를 요구하고, 인증번호를 서버 콘솔에 `[otp] <이메일> <인증번호>` 형태로 출력합니다. 운영 환경에서는 `OTP_TEST_MODE`를 설정하지 마세요.

## 공인 타임스탬프(RFC 3161)

날인할 때 PAdES 서명값의 SHA-256을 외부 시점확인 기관(TSA)에 보내 RFC 3161 타임스탬프 토큰을 받고, 이를 서명 안에 서명 타임스탬프(`id-aa-signatureTimeStampToken`)로 넣습니다. 이 토큰은 "이 서명값이 TSA가 기록한 시각에 이미 존재했다"는 것을 TSA가 자기 인증서로 서명해 보증하는 것입니다. 서명 시각이 내 서버 시계가 아니라 제3자가 보증한 시각이 되므로, 나중에 서버 시간을 조작했다거나 날인본을 뒤늦게 만들었다는 주장에 대응할 수 있습니다.

기본 TSA는 DigiCert(`http://timestamp.digicert.com`)입니다. 무료이고 가입이 필요 없으며, Adobe 신뢰 목록에 들어 있어 Acrobat/Reader가 별도 설정 없이 신뢰합니다. 요청은 문서 한 건당 한 번, 서명값의 해시만 보내므로 문서 내용은 외부로 나가지 않습니다.

| 환경 변수 | 기본값 | 설명 |
|---|---|---|
| `TSA_URL` | `http://timestamp.digicert.com` | 사용할 TSA. `http://timestamp.sectigo.com`, `https://freetsa.org/tsr`도 동작을 확인했습니다. FreeTSA는 Adobe 기본 신뢰 목록에 없습니다. |
| `TSA_ENABLED` | 켜짐 | `0`/`off`면 타임스탬프 없이 날인합니다. |
| `TSA_REQUIRED` | 꺼짐 | 켜면 TSA 실패 시 날인 자체를 실패로 처리합니다. 문서는 "날인본 생성 실패" 상태로 남고 상세 화면의 "다시 시도"로 재시도합니다. 끈 상태에서는 TSA가 응답하지 않아도(15초 제한) 타임스탬프 없이 날인을 마칩니다. |

결과는 이벤트 기록에 "타임스탬프"(TSA 주소와 시각) 또는 "타임스탬프 실패"(오류 내용)로 남고, 관리자 문서 상세 화면의 "서명 완료본 다운로드" 아래에 "공인 타임스탬프: 시각 (DigiCert)"로 표시됩니다. 이 이벤트는 날인 이후에 기록되므로 PDF 안의 감사 증명서에는 나오지 않습니다.

Adobe Acrobat Reader에서 확인하는 방법: 날인본을 열고 서명 패널을 연 뒤 서명을 펼치면 "서명에 타임스탬프가 포함되어 있습니다"가 보입니다. 서명을 우클릭해 "서명 속성 표시"를 누르면 서명 시각이 TSA 기준 시각으로 나오고, "날짜/시간" 탭(타임스탬프)의 "속성 표시"에서 TSA 인증서(DigiCert Timestamp Responder)를 볼 수 있습니다.

주의할 점은 문서에 서명하는 인증서 자체는 여전히 자체 서명 인증서(`data/cert.p12`)라는 것입니다. 그래서 Adobe는 타임스탬프는 신뢰하더라도 서명자 신원은 "확인할 수 없음"으로 표시합니다. 서명자 신원까지 신뢰받으려면 공인 인증기관 인증서로 교체해야 합니다.

명령줄 검증: `node --import ./scripts/ts-register.mjs --conditions=react-server scripts/verify-sealed.mts <날인본.pdf> [--require-timestamp]`는 ByteRange, messageDigest, 서명 인증서의 RSA 서명, 타임스탬프의 messageImprint, TSA 토큰 자체의 서명을 모두 확인하고 TSA 시각과 TSA 인증서 주체를 출력합니다.

## 테스트

```powershell
npm run typecheck
npm run smoke      # 서버 없이 workflow/날인 핵심 검사 (메일 비활성, DigiCert TSA를 한 번 호출. 끄려면 $env:SMOKE_TSA='0')
npm run build
# 테스트용 서버는 반드시 메일을 끄고 별도 데이터 폴더로 실행 (.env.local의 실제 키로 메일이 나가지 않게)
$env:MAIL_DISABLED='1'; $env:DATA_DIR="$env:TEMP\esign-e2e"; npx next start -H 127.0.0.1 -p 3195
# 다른 창에서:
node scripts/e2e.mjs http://localhost:3195
```

PowerShell에서 `$env:RESEND_API_KEY=''`는 변수를 지우는 것이라 Next가 `.env.local` 값을 다시 읽습니다. 메일을 막으려면 `MAIL_DISABLED=1`을 쓰세요.

`e2e.mjs`는 업로드, 서명자 지정, 발송, 순서 위반 거부, 토큰 노출 여부, 2인 서명, 날인본 다운로드, PAdES 서명 존재를 확인합니다.

## 서버 배포 (회사용)

- 상시 운영은 터널 대신 서버와 도메인을 씁니다. 예: VM에서 `npm run build && npm start`, 앞단에 Caddy로 HTTPS 처리.
- `APP_URL`을 실제 도메인으로 설정합니다.
- `data/` 폴더를 영속 디스크에 두고 백업합니다. DB, 원본, 날인본, 인증서가 모두 여기 있습니다.
- Vercel 같은 서버리스 환경은 로컬 디스크가 유지되지 않으므로 그대로는 맞지 않습니다. 옮기려면 `lib/db.ts`와 파일 경로 함수를 Postgres와 객체 스토리지(예: Supabase)로 바꾸세요. 저장소 접근은 `lib/db.ts`와 `lib/workflow.ts`에 모여 있습니다.
- 공인 신원 확인이 필요하면 `data/cert.p12`를 공인 인증기관 인증서로 교체하세요.

## 구조

```
app/
  login/, admin/            관리자 화면
  sign/[token]/             서명자 화면 (가입 불필요)
  api/auth/, api/admin/     관리자 API (세션 쿠키)
  api/sign/[token]/         서명자 API (토큰)
components/
  PdfPages.tsx              pdf.js 페이지 렌더러 (공용)
  admin/FieldEditor.tsx     필드 배치 편집기
  sign/SignaturePad.tsx     서명 패드
lib/
  db.ts, types.ts           SQLite 스키마와 타입
  workflow.ts               모든 상태 전이 (생성, 발송, 서명, 완료)
  seal.ts, pdf.ts           날인본 생성, 감사 페이지, PAdES
  tsa.ts                    RFC 3161 타임스탬프 요청/파싱
  mail.ts                   Resend 메일과 템플릿
  auth.ts, http.ts          관리자 세션, IP 확인, 요청 제한
scripts/
  start.ps1                 서버 + 터널 실행
  e2e.mjs                   HTTP 종단 테스트
  verify-sealed.mts         날인본 서명·타임스탬프 검증
docs/PLAN.md                설계 문서
```

## 법적 참고

한국 전자서명법(2020년 개정)에 따라 당사자가 합의한 전자서명은 효력이 인정됩니다.
분쟁에 대비해 감사 추적 페이지와 `data/`를 보관하세요. 법령이 특정 인증 수단을 요구하는 문서에는 이 도구가 맞지 않을 수 있습니다.
