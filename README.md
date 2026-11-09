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

## 테스트

```powershell
npm run typecheck
npm run smoke      # 서버 없이 workflow/날인 핵심 검사 (메일 비활성)
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
  mail.ts                   Resend 메일과 템플릿
  auth.ts, http.ts          관리자 세션, IP 확인, 요청 제한
scripts/
  start.ps1                 서버 + 터널 실행
  e2e.mjs                   HTTP 종단 테스트
docs/PLAN.md                설계 문서
```

## 법적 참고

한국 전자서명법(2020년 개정)에 따라 당사자가 합의한 전자서명은 효력이 인정됩니다.
분쟁에 대비해 감사 추적 페이지와 `data/`를 보관하세요. 법령이 특정 인증 수단을 요구하는 문서에는 이 도구가 맞지 않을 수 있습니다.
