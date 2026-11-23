# BTC Premium Cross

## 새 이름으로 Vercel에 배포

1. ZIP을 풉니다.
2. https://github.com/new 에서 **Repository name**에 `btc-premium-cross`를 입력하고 **Create repository**를 누릅니다.
3. 새 빈 저장소에서 **uploading an existing file**을 누릅니다. 압축을 푼 폴더를 열어 `index.html`, `app.js`, `premium-chart.js`, `vercel.json` 네 파일을 드래그한 뒤 **Commit changes**를 누릅니다.
4. https://vercel.com/new 에서 새 GitHub 저장소의 **Import**를 누릅니다. **Project Name**에 `btc-premium-cross`를 입력하고 **Framework Preset**은 **Other**, **Root Directory**는 기본값 `./`로 둔 뒤 **Deploy**를 누릅니다.
5. 배포 화면에서 **Visit**을 누릅니다. 주소는 Vercel이 발급합니다. 이름이 이미 사용 중이면 뒤에 원하는 짧은 문자열을 붙일 수 있습니다.
6. 화면의 **예시 차트 보기**로 그래프를 먼저 확인하세요. 체크를 풀면 실시간 Derive 입력으로 돌아갑니다.

PC에 Node.js를 설치하거나 API 키를 발급할 필요가 없습니다.

## 그래프 읽기

- 가로축은 BTC 가격 시나리오, 세로축은 옵션 프리미엄(USD)입니다.
- 현재 ATM 또는 수동 선택한 행사가를 그래프 전 구간에서 고정합니다.
- 콜과 풋 곡선은 Black-76입니다. 할인율 0%와 포워드가 BTC 가격 시나리오에 비례한다는 가정 아래, 각 옵션 IV를 적용합니다.
- 흰 다이아몬드는 콜·풋 프리미엄 교차입니다. 주황색 점선은 (콜 + 풋) ÷ 2입니다.
- 청록 점선은 같은 콜 계약의 한국시간 전일 체결 고가, 분홍 점선은 같은 풋 계약의 한국시간 전일 체결 저가입니다.
- ▲와 ▼는 곡선과 수평선의 교점입니다. 실제 실시간 돌파가 발생했다는 알림과는 구분됩니다.
- 전일 체결이 없거나 거래소 조회가 실패하면 상태를 표시하고 기준선을 생략합니다.
- Derive 티커는 선별 만기에서 1초 주기 공개 채널을 구독합니다. 30초가 지난 시세는 숨기고, 콜·풋 시각 차이가 5초를 초과하면 합산값을 표시하지 않습니다.

데이터 명세: https://docs.derive.xyz/
