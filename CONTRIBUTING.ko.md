[English](CONTRIBUTING.md) · **한국어**

# VEXPLOR Edge 에 기여하기

도와주셔서 고맙습니다. 공장 안에서 동작하는 프로그램이라 몇 가지 원칙을 지킵니다.

1. **읽기만 · 밖으로만.** PLC 에 쓰기, 포트 열기, 명령 실행, 서버가 내린 명령 따르기 같은 기능을 더하는 변경은 받지 않습니다.
   `test/safety.test.ts` 가 소스를 읽어 이 중 하나라도 있으면 실패합니다.
2. **규격은 `vexplor.edge/1`.** 바꿀 때는 더하기만 합니다(선택 칸 추가). 그 밖의 변경은 새 규격(`vexplor.edge/2`)으로
   냅니다. 정본은 이 저장소(`docs/계약.md` · `docs/schemas` · `docs/examples`)이고, VEXPLOR AAS Studio 는 서버가 따르는
   사본을 두고, 상호 시험으로 둘이 같은지 대조합니다.
3. **고장은 시험부터** — 먼저 실패하는 시험을 쓰고, 그다음에 고칩니다.
4. **주석은 영어**, 사람이 보는 글은 영어와 한국어.

## 실행

```bash
npm ci && npm run typecheck && npm run build && npm test
AAS_DIR=../vexplor-aas npm run test:interop   # 빌드한 waceinc/vexplor-aas 사본이 필요합니다
```

## 판을 올릴 때

`EDGE_VERSION`(`src/version.ts`)이 오르면 수집기를 설명하는 곳을 같은 릴리스에서 모두 고칩니다 — 하나라도 옛 판이거나 바뀐 것이
빠져 있으면 릴리스가 끝난 것이 아닙니다.

1. **판 표기** — `src/version.ts` · `package.json` · 두 README 의 「판」 표.
2. **바뀐 것** — README 표와 그 기능 안내(`docs/install.md` · `docs/설치.md` · 규격), 영어와 한국어.
3. **릴리스** — `npm run pack:release`, 태그 `vX.Y.Z`, Linux 꾸러미 둘 · `get.sh` · `SHA256SUMS` 첨부. 한 줄 설치는 늘
   `releases/latest/download/get.sh` 를 받고, 그 파일은 자기 릴리스 판에 고정돼 있습니다.
4. **웹사이트** — wace.me 의 VEXPLOR Edge 페이지(국 · 영 · 일)와 `gh-pages` 브랜치의 프로젝트 페이지
   (waceinc.github.io/vexplor-edge): 판 표기와 바뀐 것. 판을 올리는 사람이 코드를 보고 직접 작성합니다. 매일 점검이 최신 릴리스와
   README · 웹사이트를 대조합니다.
   검색과 AI 답변은 wace.me 의 두 곳을 더 읽습니다 — 제품 페이지 구조화 데이터의 `softwareVersion` 과 `/opensource` 프로젝트 카드의 판.
   둘 다 `wace-home/scripts/oss_seo.py` 의 `VERSIONS` 에서 만들어집니다(명령 4개는 사이트 저장소 README, Edge 페이지 본문의 판은 `build-edge-page.py`). 배포 전에 두 번 실행해
   두 번째에 바뀌는 것이 없는지 보고, 배포 뒤 바뀐 주소를 IndexNow 로 알립니다.

기여한 내용은 이 저장소의 [Apache License 2.0](LICENSE)으로 배포됩니다.
