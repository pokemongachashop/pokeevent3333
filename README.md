# 피카 서바이벌 (Pika Survival) — 설정·배포·테스트 가이드

게임 실행에 필요한 파일은 `index.html`, `style.css`, `game.js` 세 개뿐입니다. 이 README는 안내용이며 배포하지 않아도 됩니다.

---

## 4. Firebase 프로젝트 생성 및 Realtime Database 설정

1. https://console.firebase.google.com 에서 **프로젝트 추가** → 이름 입력 → (Google 애널리틱스는 꺼도 됨) → 만들기.
2. 왼쪽 메뉴 **빌드 → Realtime Database → 데이터베이스 만들기**.
   - 위치: `asia-southeast1(싱가포르)` 권장(한국에서 지연이 가장 적음).
   - 보안 규칙 시작 모드: **잠금 모드**로 시작하세요(6번에서 규칙을 넣습니다).
3. **프로젝트 설정(톱니바퀴) → 일반 → 내 앱 → 웹(`</>`)** 으로 앱을 등록합니다. Hosting 설정은 체크하지 않아도 됩니다.
4. 표시되는 `firebaseConfig` 값을 `game.js` 맨 위 `FIREBASE_CONFIG`에 붙여 넣습니다.

```js
const FIREBASE_CONFIG = {
  apiKey: 'AIza...',
  authDomain: '프로젝트ID.firebaseapp.com',
  databaseURL: 'https://프로젝트ID-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: '프로젝트ID',
  storageBucket: '프로젝트ID.appspot.com',
  messagingSenderId: '...',
  appId: '1:...:web:...',
};
```

- `databaseURL`이 비어 있으면 온라인 플레이가 비활성화되고 "Firebase 설정 필요"가 표시됩니다. Realtime Database 화면 상단의 URL을 그대로 복사하세요.
- 이 값들은 **웹 클라이언트용 공개 설정**이라 GitHub에 올라가도 괜찮습니다. 데이터 보호는 6번의 보안 규칙이 담당합니다.
- **관리자 비밀키·서비스 계정 키(JSON)는 절대 `game.js`에 넣지 마세요.**

## 5. Firebase Authentication 설정 (참가자 익명 로그인 + 관리자 계정)

참가자는 탭마다 자동으로 익명 로그인하고, 그 UID를 플레이어 ID로 씁니다(같은 탭 새로고침 시 같은 UID → 재접속 시 중복 방지).
**방 만들기·맵 선택·경기 시작·재경기는 관리자 계정으로 로그인한 사람만** 할 수 있습니다.

1. **빌드 → Authentication → 시작하기**.
2. **로그인 방법**에서 **익명**과 **이메일/비밀번호** 두 가지를 모두 **사용 설정**합니다.
3. **사용자 → 사용자 추가**로 관리자 계정을 만듭니다.
   - 이메일: `game.js`의 `ADMIN_EMAIL` 값(기본 `admin@pika-survival.app`). 실제로 받는 메일 주소가 아니어도 됩니다.
   - 비밀번호: 관리자가 게임 화면에서 입력할 비밀번호(6자 이상, 남이 추측하기 어렵게).
   - 이메일을 바꾸고 싶다면 `game.js`의 `ADMIN_EMAIL`과 6번 보안 규칙 안의 이메일을 **둘 다 같은 값**으로 바꾸세요.
4. **설정 → 승인된 도메인**에 `내아이디.github.io`를 추가합니다.

게임 화면 사용법:

- 관리자: 메인 화면 아래 **관리자**를 펼쳐 비밀번호만 입력 → 로그인하면 **방 만들기** 버튼이 나타납니다.
- 참가자: 방 만들기 버튼이 보이지 않고, 관리자에게 받은 방 코드로 참가만 할 수 있습니다.
- 관리자는 대기실에서 **"나도 참가"**를 켜고 끌 수 있습니다. 끄면(기본값) 진행만 하고 경기에는 관전자로 들어갑니다.
- 관리자가 **방 닫기**를 누르면 방이 삭제되고 모든 참가자가 메인 화면으로 돌아갑니다.
- 비밀번호는 `game.js`에 저장되지 않으므로 GitHub에 코드를 공개해도 비밀번호가 드러나지 않습니다. 관리자 로그인은 그 탭에서만 유지됩니다.

## 6. Firebase 보안 규칙 설정

**Realtime Database → 규칙** 탭에 아래 내용을 붙여 넣고 **게시**합니다. "누구나 읽고 쓰기" 규칙은 사용하지 않습니다.
관리자 이메일을 바꿨다면 규칙 안의 `admin@pika-survival.app`도 같이 바꾸세요(한 군데).

```json
{
  "rules": {
    ".read": false,
    ".write": false,
    "rooms": {
      "$code": {
        ".validate": "$code.matches(/^[A-Z0-9]{6}$/)",
        ".read": "auth != null",
        ".write": "auth != null && !newData.exists() && data.child('info/adminId').val() === auth.uid",

        "info": {
          ".write": "auth != null && ((!data.exists() && auth.token.email === 'admin@pika-survival.app' && newData.child('adminId').val() === auth.uid && newData.child('hostId').val() === auth.uid) || data.child('adminId').val() === auth.uid)",
          ".validate": "newData.hasChildren(['adminId', 'hostId', 'status', 'mapId', 'maxPlayers', 'createdAt'])",
          "adminId": { ".validate": "newData.isString() && (!data.exists() || newData.val() === data.val())" },
          "hostId": {
            ".write": "auth != null && root.child('rooms/' + $code + '/players/' + auth.uid).exists() && (data.val() === auth.uid || (newData.val() === auth.uid && (root.child('rooms/' + $code + '/players/' + data.val() + '/online').val() !== true || root.child('rooms/' + $code + '/players/' + data.val() + '/lastSeen').val() < now - 30000)))",
            ".validate": "newData.isString() && (newData.val() === newData.parent().child('adminId').val() || root.child('rooms/' + $code + '/players/' + newData.val()).exists())"
          },
          "status": {
            ".write": "auth != null && root.child('rooms/' + $code + '/info/hostId').val() === auth.uid && (newData.val() === 'playing' || newData.val() === 'results')",
            ".validate": "newData.isString() && newData.val().matches(/^(lobby|countdown|playing|results)$/)"
          },
          "mapId": { ".validate": "newData.isString() && newData.val().matches(/^(meadow|ice|cloud|toy|random)$/)" },
          "maxPlayers": { ".validate": "newData.isNumber() && newData.val() >= 2 && newData.val() <= 20" },
          "createdAt": { ".validate": "newData.isNumber()" },
          "matchId": { ".validate": "newData.isString() && newData.val().length <= 40" },
          "$other": { ".validate": false }
        },

        "players": {
          ".validate": "newData.numChildren() <= 21",
          "$uid": {
            ".write": "auth != null && (auth.uid === $uid || (!newData.exists() && (root.child('rooms/' + $code + '/info/hostId').val() === auth.uid || root.child('rooms/' + $code + '/info/adminId').val() === auth.uid)))",
            ".validate": "newData.hasChildren(['nickname', 'characterId', 'joinedAt'])",
            "nickname": { ".validate": "newData.isString() && newData.val().length >= 1 && newData.val().length <= 12" },
            "characterId": { ".validate": "newData.isString() && newData.val().matches(/^(pikachu|eevee|jigglypuff|piplup|psyduck|snorlax|pawmi|togepi|rowlet|fuecoco|gengar|mimikyu)$/)" },
            "ready": { ".validate": "newData.isBoolean()" },
            "spectator": { ".validate": "newData.isBoolean() && (newData.val() === false || root.child('rooms/' + $code + '/info/adminId').val() === $uid)" },
            "online": { ".validate": "newData.isBoolean()" },
            "joinedAt": { ".validate": "newData.isNumber()" },
            "lastSeen": { ".validate": "newData.isNumber()" },
            "sid": { ".validate": "newData.isString() && newData.val().length <= 32" },
            "$other": { ".validate": false }
          }
        },

        "pos": {
          ".write": "auth != null && !newData.exists() && root.child('rooms/' + $code + '/info/adminId').val() === auth.uid",
          "$uid": {
            ".write": "auth != null && (auth.uid === $uid || (!newData.exists() && (root.child('rooms/' + $code + '/info/hostId').val() === auth.uid || root.child('rooms/' + $code + '/info/adminId').val() === auth.uid)))",
            ".validate": "newData.hasChildren(['x', 'y', 'z', 'mid'])",
            "x": { ".validate": "newData.isNumber() && newData.val() >= -600 && newData.val() <= 2000" },
            "y": { ".validate": "newData.isNumber() && newData.val() >= -600 && newData.val() <= 1600" },
            "z": { ".validate": "newData.isNumber() && newData.val() >= -400 && newData.val() <= 400" },
            "st": { ".validate": "newData.isString() && newData.val().matches(/^(idle|run|air|hit|drop|out)$/)" },
            "f": { ".validate": "newData.isNumber() && (newData.val() === 1 || newData.val() === -1)" },
            "e": { ".validate": "newData.isString() && newData.val().matches(/^[SJHF]{0,4}$/)" },
            "t": { ".validate": "newData.isNumber()" },
            "mid": { ".validate": "newData.isString() && newData.val().length <= 40" },
            "$other": { ".validate": false }
          }
        },

        "match": {
          ".write": "auth != null && root.child('rooms/' + $code + '/info/adminId').val() === auth.uid",
          "waves": { ".write": "auth != null && root.child('rooms/' + $code + '/info/hostId').val() === auth.uid" },
          "result": { ".write": "auth != null && root.child('rooms/' + $code + '/info/hostId').val() === auth.uid" },
          "elim": {
            ".write": "auth != null && root.child('rooms/' + $code + '/info/hostId').val() === auth.uid",
            "$uid": {
              ".write": "auth != null && auth.uid === $uid && !data.exists() && root.child('rooms/' + $code + '/match/meta/roster/' + $uid).exists()",
              ".validate": "newData.hasChildren(['at', 'ms', 'mid'])"
            }
          },
          "items": {
            ".write": "auth != null && root.child('rooms/' + $code + '/info/hostId').val() === auth.uid",
            "$item": {
              "by": {
                ".write": "auth != null && !data.exists() && newData.val() === auth.uid && root.child('rooms/' + $code + '/match/meta/roster/' + auth.uid).exists()",
                ".validate": "newData.parent().child('t').exists()"
              }
            }
          },
          "fx": {
            ".write": "auth != null && root.child('rooms/' + $code + '/info/hostId').val() === auth.uid",
            "$fx": {
              ".write": "auth != null && !data.exists() && newData.child('by').val() === auth.uid && root.child('rooms/' + $code + '/match/meta/roster/' + auth.uid).exists()",
              ".validate": "newData.hasChildren(['by', 'x', 'y', 'at', 'mid'])"
            }
          }
        }
      }
    }
  }
}
```

권한 구조:

- **관리자**(방을 만든 관리자 계정, `info/adminId`): 방 생성·삭제, 맵 선택, 경기 시작, 재경기, 대기실로 되돌리기. 관리자 이메일로 로그인한 계정만 방을 만들 수 있습니다.
- **진행 담당**(`info/hostId`): 붕괴 웨이브·아이템 생성·탈락 처리·결과 기록. 평소엔 관리자이고, **경기 도중 관리자 연결이 30초 이상 끊기면** 남은 참가자 한 명이 이번 경기 진행만 대신 맡아 경기를 끝까지 마칩니다. 진행 대행자도 새 경기를 시작하거나 맵을 바꿀 수는 없습니다. 관리자가 돌아오면 대기실·결과 화면에서 진행 담당을 자동으로 되찾습니다.
- 참가자: 자기 플레이어·위치·탈락 기록만 쓸 수 있고, 아이템은 먼저 집은 한 명만 가져갑니다.
- 닉네임 1~12자, 허용된 캐릭터·맵·상태값, 좌표 범위, 허용 필드만 저장됩니다. "진행만" 표시(`spectator`)는 관리자만 켤 수 있습니다.

규칙의 한계(반드시 읽어 주세요):

- **클라이언트가 직접 쓰는 구조라 위치·탈락·우승 판정을 완전히 신뢰할 수 없습니다.** 조작된 클라이언트는 규칙 범위 안의 값을 거짓으로 보낼 수 있고, 진행 담당 클라이언트가 결과를 기록합니다. 치트 방지와 권위 있는 판정이 필요하면 Cloud Functions(유료 Blaze 요금제) 또는 별도 게임 서버가 필요합니다.
- 참가 정원 20명(관리자가 "진행만"일 때 관리자 제외)은 클라이언트 확인 + `numChildren() <= 21` 검증으로 걸었지만, 여러 명이 동시에 마지막 자리에 들어오는 경합까지 완벽히 막는다고 보장할 수 없습니다. 게시 전 **규칙 플레이그라운드**에서 확인해 보세요.
- 관리자 비밀번호가 유출되면 누구나 방을 만들 수 있습니다. 유출이 의심되면 콘솔 Authentication에서 비밀번호를 바꾸세요.

## 7. GitHub 저장소에 세 파일 올리기

1. https://github.com/new 에서 저장소 생성(예: `pika-survival`), **Public** 선택.
2. 저장소 화면 **Add file → Upload files** → `index.html`, `style.css`, `game.js`를 끌어다 놓기 → **Commit changes**.
3. 파일은 저장소 **최상위**에 있어야 합니다(폴더 안에 넣지 마세요).

명령줄을 쓴다면:

```bash
git init && git add index.html style.css game.js
git commit -m "Pika Survival 첫 배포"
git branch -M main
git remote add origin https://github.com/내아이디/pika-survival.git
git push -u origin main
```

## 8. GitHub Pages 활성화

1. 저장소 **Settings → Pages**.
2. **Source: Deploy from a branch**, **Branch: `main` / `(root)`** → Save.
3. 1~2분 뒤 `https://내아이디.github.io/pika-survival/` 주소가 표시됩니다.
4. 이후 `game.js`를 수정해 커밋하면 자동으로 다시 배포됩니다. 브라우저 캐시 때문에 바로 안 바뀌면 강력 새로고침(Ctrl+Shift+R)을 하세요.

## 9. 최초 실행 및 테스트

1. 배포 주소를 PC 브라우저로 엽니다. 메인 화면 상태 표시가 **"Firebase 연결됨"**인지 확인합니다.
   - "Firebase 설정 필요": `FIREBASE_CONFIG` 미입력 / "Firebase 연결 실패": 값 오타 또는 익명 로그인 꺼짐 / "SDK 로드 실패": 네트워크나 광고 차단기.
2. **혼자 연습하기**로 Firebase 없이 조작·물리·붕괴·탈락·결과·재경기를 먼저 확인할 수 있습니다(데이터는 저장되지 않는 오프라인 모드).
3. 메인 화면 **관리자**에서 비밀번호 입력 → 로그인 → 닉네임 입력 → **방 만들기** → 대기실에서 6자리 방 코드 확인.
4. Firebase 콘솔 **Realtime Database → 데이터** 탭에서 `rooms/방코드/info`, `players` 가 생겼는지 확인합니다.
5. 문제가 생기면 F12 개발자 도구 콘솔의 `[PikaSurvival]` 로그를 확인합니다(인증 토큰은 출력하지 않습니다).

## 10. 2명 이상 멀티플레이 테스트 절차

같은 PC에서 **탭마다 다른 플레이어**로 인식되므로 탭 두 개로도 테스트할 수 있습니다.

1. 탭 A: 관리자 로그인 → 방 만들기 → 방 코드 복사.
2. 탭 B·C(또는 휴대폰): 다른 닉네임 + 방 코드 → 참가. 모든 탭 참가자 목록에 즉시 나타나는지, 탭 B·C에는 **방 만들기·경기 시작·맵 선택이 보이지 않거나 비활성**인지 확인.
   - 관리자가 "진행만"이면 참가자가 2명 이상이어야 시작됩니다. 탭 2개로만 테스트하려면 관리자 탭에서 **나도 참가**를 켜세요.
3. 탭 B에서 캐릭터 변경·준비 완료 → 탭 A 목록에 실시간 반영되는지 확인.
4. 탭 A(관리자)에서 맵 선택 → 탭 B에서 선택 표시가 바뀌는지, 탭 B에서는 맵을 바꿀 수 없는지 확인.
5. **경기 시작** → 두 탭 모두 같은 카운트다운, 같은 맵, 서로의 캐릭터 움직임(약 0.2초 지연 보간) 확인.
6. 15초 뒤 같은 발판이 양쪽에서 동시에 빨갛게 흔들리고 사라지는지 확인.
7. 한 명이 떨어지면 → 탈락자는 관전 UI(◀ ▶, 전체 보기), 생존자는 우승 → 양쪽 결과 화면 동일 여부 확인.
8. **재경기** → 발판·타이머·아이템·탈락 상태가 모두 초기화되는지 확인.
9. 예외 상황:
   - 경기 중 탭 B **새로고침** → 같은 플레이어로 복귀(살아 있었다면 마지막 위치에서 계속, 탈락했다면 관전).
   - 경기 중 관리자 탭 A **닫기** → 탭 B·C에 "관리자 연결이 끊겨 … 경기 진행을 이어받았습니다" 안내 후 붕괴·판정이 끝까지 진행되는지. 결과 화면에서 재경기 버튼은 관리자에게만 보입니다.
   - 관리자가 **방 닫기** → 참가자 화면에 "관리자가 방을 닫았습니다"가 표시되는지.
   - 휴대폰 Wi-Fi 끄기 → 상단 "네트워크 연결이 끊겼습니다" 배너, 약 8초 후 경기에서는 연결 끊김 탈락 처리.
   - 없는 방 코드, 6자리가 아닌 코드 입력 시 오류 메시지.

## 11. 20명 동시 접속 테스트 시 확인할 항목

20명 동시 플레이는 **실제 기기로 검증하지 않았습니다.** 아래 순서로 단계적으로 늘려 가며 확인해 주세요(5명 → 10명 → 20명).

- **Esc(모바일은 ☰) 메뉴 하단 통계**: 내 위치 전송 횟수/초(움직일 때 약 8회, 멈추면 0), 수신 횟수/초(20명이면 최대 약 150회).
- **Firebase 콘솔 → Realtime Database → 사용량**: 동시 연결 수(Spark 한도 100), 다운로드 용량(Spark 월 10GB), 저장 용량.
  - 대략적 추정: 20명이 모두 계속 움직이면 경기 1판(3분 30초)에 수십 MB가 내려받아질 수 있습니다. **Spark 무료 한도 안에 머문다고 보장할 수 없으니** 첫 이벤트 후 사용량 그래프를 꼭 확인하세요.
- 저사양 휴대폰에서 끊김이 있으면 메뉴의 **효과 줄이기**를 켜 보세요.
- 원격 캐릭터 움직임이 뚝뚝 끊기면 `game.js`의 `CFG.net.interpDelayMs`를 250~300으로, 사용량이 많으면 `sendIntervalMs`를 150~200으로 올려 조정하세요.
- 결과 화면 순위가 모든 기기에서 같은지, 우승 판정이 한 번만 나오는지.
- 관리자 기기를 경기 중 끄고 경기가 이어지는지(20명 상태에서).
- 21번째 참가 시 "방 인원이 가득 찼습니다"가 나오는지.

## 12. 알려진 제한 사항과 후속 개선 방향

검증 상태(정직하게 구분합니다):

| 항목 | 상태 |
|---|---|
| 관리자 로그인(틀린 비밀번호 거부)·관리자만 방 생성/맵 선택/시작/재경기, "나도 참가" 켜기·끄기, 참가자 2명 경기→결과, 관리자 방 닫기 | 탭 3개 + Firebase 대역(브라우저 내 공유 저장소)으로 자동 테스트 확인. **실제 Firebase와 보안 규칙에서는 미검증** |
| 세 파일 문법 검사, 연습 모드 전체 흐름(방 열기→캐릭터/맵 선택→카운트다운→이동·점프→발판 붕괴→낙하 탈락→결과→재경기→대기실→나가기), 아이템 획득·사용, 모바일 세로 배치(조작부와 경기장 비겹침), 조이스틱+점프 동시 터치 | 헤드리스 브라우저 자동 테스트로 확인 |
| Phaser 실제 화면 렌더링(발판·캐릭터 그림, 카메라) | **미검증** — 테스트 환경에서 CDN 접근이 막혀 Phaser 대역으로 로직만 확인 |
| Firebase 실시간 동기화, 보안 규칙, 관리자 이탈·재접속, 2명 이상 멀티플레이 | **미검증** — 실제 Firebase 프로젝트에서 10번 절차로 확인 필요 |
| 20명 동시 접속 성능·사용량 | **미검증** |
| GitHub Pages 배포 | **미검증**(정적 파일 3개라 동작해야 하지만 직접 확인하지 않음) |

제한 사항:

- 서버가 없어 진행 담당(평소 관리자) 클라이언트가 진행을 결정합니다. 관리자 탭이 백그라운드로 가면 브라우저가 타이머를 늦춰 붕괴가 늦어질 수 있으니 **경기 중 관리자 화면은 앞에 띄워 두세요.** 30초 무응답 시 다른 참가자가 이번 경기만 이어받습니다.
- 관리자가 없으면 새 경기를 시작할 수 없습니다(의도된 동작).
- 위치·탈락·결과는 클라이언트가 보고하므로 **치트를 완전히 막을 수 없습니다.**
- 관리자가 "방 닫기" 없이 창을 닫으면 방이 데이터베이스에 남습니다(같은 탭을 다시 열면 그 방으로 복귀). 주기적으로 콘솔에서 오래된 `rooms`를 지우거나 Cloud Functions 예약 작업으로 정리하세요.
- 같은 브라우저 탭을 "탭 복제"하면 같은 세션이 복사되어 먼저 열린 탭이 자동으로 연결 종료됩니다.
- 캐릭터 이미지는 기본적으로 자체 제작 임시 마스코트입니다. 적법하게 사용할 수 있는 이미지가 있으면 `CHARACTERS`의 `imageUrl`에 URL을 넣으세요(CORS 허용 주소 필요, 실패 시 자동으로 임시 마스코트로 돌아감).

후속 개선 방향:

- Cloud Functions로 탈락·결과 검증, 오래된 방 자동 정리.
- 위치를 묶어 보내는 방식(진행 담당이 일정 주기로 모든 위치를 묶어 중계)으로 다운로드량 절감.
- 효과음·배경음, 관전자 응원 이모트, 맵 추가, 운영진 여러 명(관리자 이메일 목록) 지원.
