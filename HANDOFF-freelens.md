# Freelens: bàn giao cho agent tiếp theo

Cập nhật lúc: 24/10/2026, 13:45 (giờ Việt Nam).
Đọc hết file này trước khi sửa code.

## 1. Bối cảnh

- **Repo:** `C:\dev\freelens`, là fork của freelensapp/freelens, một Kubernetes IDE (Electron).
  - Remote `fork` = `https://github.com/hoaipham-ru/freelens.git`.
  - Remote `origin` = upstream.
- **Máy:** Windows; shell là PowerShell. `pnpm` nằm ở `C:\dev\tools\pnpm.exe` và **không có trong PATH**. Mỗi phiên shell phải chạy:
  ```powershell
  $env:PATH = "C:\dev\tools;$env:PATH"
  ```
- **Người dùng:** nói tiếng Việt, muốn câu trả lời ngắn và thẳng, và muốn được nói rõ khi có đánh đổi.
- **Cluster đang dùng để thử:** `kube`. Trong app đóng gói nó có tên `kube_PL`; Kubernetes v1.30.14. Có Istio (Gateway, VirtualService) và APISIX ở chế độ traditional (route lưu trong etcd).

## 2. Các nhánh

| Nhánh | Nội dung | Trạng thái |
|---|---|---|
| `feat/ui-v2-themes` | Theme v2: Graphite Dark, Dracula, Paper Light. Có PR #2839 lên upstream. | Commit `8a896625` (sửa lỗi "theo hệ thống" nhảy sang Dracula) **chưa push** lên `fork`; PR vẫn chứa code cũ. Phải hỏi người dùng trước khi push. |
| `feat/topology` | Trang Topology: Overview / Architecture / Network flow, Istio, APISIX, layout dagre. | Chưa push, chưa có PR. |
| `feat/service-map` | Trang Service Map. | Chưa push. Hai commit `a56bad22` và `b1c5c4ce` nằm trên nền `local/ui-v2-topology`, chưa tách riêng ra khỏi nền đó. |
| `local/ui-v2-topology` | **Nhánh đang dùng.** Gộp cả ba nhánh trên, thêm commit `0beb766d` đổi tên app thành **"Freelens Local"** (appId `app.freelens.FreelensLocal`). | Chỉ dùng cục bộ, không được đẩy lên upstream. |

Mọi commit của nhánh này so với `origin/main`, mới nhất ở trên:
```
b1c5c4ce Show the pods behind an incident's Services and routes
a56bad22 Add a Service Map page that groups problems into incidents
0beb766d Package this branch as Freelens Local, next to the official app
c388ef08 Update the custom resources sidebar snapshot for the merged branch
e8d0be8f Merge branch 'feat/topology' into local/ui-v2-topology
fe7de498 Update the snapshots of cluster pages for the Topology item
927fe0c4 / d316b1b3 Merge branch 'feat/ui-v2-themes'
8a896625 Follow the system with the classic theme, not a v2 one
32bfcb6b / e3fa8681 / 4d461407 / 07b9f65a  (Topology)
37f4b1a5 / 3474417d / 78a8da08              (theme v2)
```

Lưu ý về working tree: khoảng 50 file `*.snap` hiện "modified", nhưng chỉ khác kiểu xuống dòng (LF/CRLF). Đây là nhiễu, đừng commit chúng.
- Xem thay đổi thật: `git diff --ignore-cr-at-eol --name-only`.
- Commit snapshot: chỉ `git add` những file mà lệnh trên liệt kê.

## 3. Cấu trúc code đã thêm

Tất cả nằm dưới `packages/core/src/`.

### Topology (`renderer/components/topology/`)
- `topology-model.ts`: phần lõi thuần, không dùng store hay DI, có test.
  - `buildTopology(input, "architecture"|"network")` dựng đồ thị trên **mọi** namespace.
  - `focusTopology` lọc theo namespace đang chọn; `buildOverview` gộp mỗi namespace thành một thẻ.
  - Layout dùng dagre (`@dagrejs/dagre` 3.1.1, giấy phép MIT; **không dùng ELK** vì là EPL). Đường nối vuông góc, chỉ bẻ ở khe giữa các cột.
  - Đã export thêm cho Service Map: `layoutCards(graph, sizeOf)`, `keyOf`, `podTemplateOf`, `isApiServer`, và `creationTimestamp`/`annotations` trong `RawObject`.
- `topology.tsx`: trang Topology.
  - Zoom bằng bánh xe chuột (wheel listener gắn qua callback ref), kéo để di chuyển, nhãn trên cạnh.
  - Panel APISIX.
- `apisix-admin.ts`: dùng chung cho Topology và Service Map.
  - `apisixKeysOf(...)`: tự lấy **viewer key** từ ConfigMap `config.yaml` của APISIX. Không bao giờ dùng admin key. Key người dùng tự nhập thì ưu tiên hơn.
  - `readApisix(...)`: đọc Admin API qua service proxy của Kubernetes.
- `apisix-keys-storage.injectable.ts`: lưu key người dùng nhập, theo từng cluster.
- Route và điều hướng: `common/front-end-routing/routes/cluster/topology/`. Thứ tự sidebar: `common/sidebar-menu-items-starting-order.ts` (Topology = 15).

### Service Map (`renderer/components/service-map/`)
- `service-map-model.ts`: phần lõi thuần, có test. Các bước:
  1. **Issue** sinh ra từ luật trên manifest:
     - pod: crashloop, image-pull, config-error, oom (OOM quá 24 giờ trước chỉ là info), unschedulable, stuck-init, stuck-creating, not-ready, restarts, evicted;
     - workload: replica-shortfall, rollout-stuck, scaled-to-zero;
     - Job và CronJob;
     - Service: no-endpoints, no-pods, lb-pending;
     - route hoặc Ingress trỏ tới thứ không tồn tại;
     - Secret, ConfigMap, PVC hoặc pull secret bị thiếu;
     - PVC ở trạng thái Pending; node NotReady hoặc bị pressure;
     - nhiều Warning event dồn dập.
  2. **Link:** cạnh lấy từ Topology (routes / exposes / calls), cộng thêm uses, pulls (registry), runs-on (node), needs (LB provider), và mentions (Service được nhắc tới trong nội dung Warning event).
  3. **Incident:** các node có issue nối với nhau thì gộp thành một (union-find). Root là node "cuối chuỗi" (không có cạnh đi ra trong incident). Khi có nhiều ứng viên thì xếp theo `severityOf` → `rootScore` → số node phụ thuộc. Node khoẻ gửi traffic vào incident thì được đánh dấu là at risk.
  4. Mọi LoadBalancer đang chờ địa chỉ được gom thành **một** incident chung (`lbprovider//`).
  5. Issue mức `info` không thành incident mà vào mục **housekeeping**.
  6. Hàm `explain()` sinh tiêu đề, nguyên nhân, việc nên làm và lệnh kubectl cho từng luật.
  7. `podBoxes()` / `workloadsOf()` dựng chế độ xem Pods. Với Service hoặc route trong incident, hàm đi theo routes/exposes tới workload phía sau (trường `behind`). Chỉ áp dụng cho object nằm trong incident, không áp dụng cho object at risk.
- `service-map.tsx`: giao diện ba cột.
  - Cột trái: danh sách incident, có nút ẩn/hiện, và mục housekeeping.
  - Giữa: bản đồ Services hoặc Pods, kèm timeline "What changed" lấy từ Warning event.
  - Phải: panel cho incident, cho node đang chọn, hoặc cho pod đang chọn.
  - Khi cửa sổ hẹp dưới 1150px, dùng container query để thu gọn.
  - Tên Secret lấy bằng `GET /api/v1/secrets` với header `Accept: application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1`, nên **chỉ đọc tên, không đọc dữ liệu**.
  - Dòng log cuối của pod lấy qua `callForLogs`; nút Open logs dùng `createPodLogsTab`.
  - Danh sách incident đã mute lưu trong `service-map-mutes-storage.injectable.ts`.
- `service-map-sidebar.test.tsx`: kiểm tra mục sidebar nằm ngay sau Topology. Route `/service-map` ở `common/.../routes/cluster/service-map/`; thứ tự sidebar là 16.
- File `register-injectables.ts` là file **sinh tự động**. Sau khi thêm hoặc xoá một file `*.injectable.ts`, chạy `pnpm build:di`.

## 4. Lệnh hay dùng

Chạy tất cả từ `C:\dev\freelens`, sau khi đã chỉnh PATH như mục 1.

```powershell
pnpm build:di                                            # sinh lại register-injectables
pnpm biome check --write <đường dẫn>                     # lint và format
cd packages\core; pnpm exec tsc --noEmit -p tsconfig.json; cd ..\..   # type check
$env:TZ="UTC"; pnpm exec vitest run -c vitest.config.ts --project @freelensapp/core <file hoặc thư mục>
pnpm --stream knip:check
pnpm trunk check --no-fix <các file>
pnpm dev                                                 # chạy dev; CDP ở cổng 9223
```

**Những chỗ dễ vấp:**
- **Cache của Vitest:** khi thêm file `*.injectable.*` mới, Vitest có thể dùng `import.meta.glob` đã cache từ trước, nên test không thấy file mới. Trước khi chạy cả bộ test, chạy:
  ```powershell
  pnpm exec vitest --clearCache -c vitest.config.ts
  ```
- **Chạy cả bộ test:** thêm `--reporter=json --outputFile=C:\dev\tools\vt-full.json`. Lọc lỗi bằng `node C:\dev\tools\vt-failures.cjs <file json>`; thêm `--list-snapshot-files` để chỉ lấy các file lỗi do snapshot. Sau đó chạy `-u` **chỉ cho những file đó**. Không bao giờ chạy `-u` cho cả bộ test, vì nó ghi đè snapshot của các test vốn đã fail sẵn.
- **9 file test luôn fail trên Windows, bất kể nhánh nào:**
  - `extension-discovery`, `extension-loader-reload`, `managed-directory`, `kubectl.test`;
  - 4 test helm-repository trong preferences;
  - `navigation-to-kubernetes-preferences`.
- **Knip:** trên Windows báo 2 "Unresolved imports" cho `src\vitest.setup.tsx` và `vitest-after-env.setup.ts`. Có vẻ do lỗi đường dẫn trên Windows chứ không do code mới, nhưng chưa xác minh trên nhánh khác.
- **Vite dev** không nhận dependency mới trong `node_modules` cho tới khi khởi động lại `pnpm dev`.
- **Không chạy `pnpm build` khi `pnpm dev` đang chạy.**
- **Script kiểm tra UI qua CDP** nằm trong `C:\dev\tools`:
  - `open-service-map.mjs <out.png> [tên incident] [pods|services]`;
  - `sm-probe.mjs`, `page-state.mjs`, `back-to-topology.mjs`, `open-topology.mjs`.
  - Bấm vào các node bằng `dispatchEvent("click")`, vì canvas dùng `overflow: clip`.
  - Người dùng có thể đang dùng app dev cùng lúc: chụp màn hình thì được, nhưng hạn chế đổi trang hoặc đổi namespace của họ; nếu có đổi thì trả lại như cũ.

## 5. Đóng gói

```powershell
pnpm build
cd freelens; pnpm exec electron-builder --publish never --win
```
- Kết quả trong `freelens\dist`: `Freelens Local Setup 2.0.0-0.exe` và bản portable `Freelens Local 2.0.0-0.exe`.
- Phải tắt hết tiến trình "Freelens Local" trước khi đóng gói.
- App cài song song với Freelens 1.10.3 bản chính thức:
  - dữ liệu của bản đóng gói: `%APPDATA%\Freelens Local`;
  - dữ liệu của chế độ dev: `%APPDATA%\Freelens LocalDev`.
- Người dùng tự đóng gói, đã có hướng dẫn. Bản đã đóng gói gần nhất **chưa có** commit `b1c5c4ce`.

## 6. Những gì đã biết về cluster

Dùng để kiểm tra xem Service Map có báo đúng không.
- vault: StatefulSet 0/1 ready, readiness fail. `vault-standby` được gộp vào cùng incident.
- `pvi-gqkn`: ImagePullBackOff, image lấy từ `docker-nexus.paraline.io`.
- Các CronJob `flink-iceberg-maintenance-metadata/orphans` fail liên tục.
- Route APISIX trỏ tới Service `nifi` không tồn tại. Các route APISIX thật: `dremio.paraline.io` → `dremio.dremio:9047`; `/portal/*` → `hanas-gateway`.
- VirtualService `airflow-vs` và `datahub-vs` tham chiếu Gateway không tồn tại.
- Secret `hanas-tls-nginx` không tồn tại.
- Không có LoadBalancer controller, nên 4–5 Service LB đang chờ địa chỉ. Gateway của Istio dùng `spec.externalIPs`.
- Admin API của APISIX lộ ra ngoài qua `apisix.paraline.io`, `allow_admin` = `0.0.0.0/0`, etcd không có auth. Kế hoạch xử lý nằm trong doc "Kế hoạch đưa route APISIX về cấu hình khai báo": https://claude.ai/artifact/DbjyxJ9LZBuKJ8zvtnbbgd

## 7. Việc còn mở / ý tưởng tiếp theo

1. **Hỏi người dùng** có push `8a896625` lên PR #2839 (`fork/feat/ui-v2-themes`) không.
2. Nếu muốn PR Service Map lên upstream: tách hai commit Service Map sang một nhánh mới tạo từ `feat/topology`, bỏ phần đổi tên app (`0beb766d`) và phần theme.
3. Service Map chưa hiểu custom resource:
   - Kafka / KafkaTopic (Strimzi), VaultConnection / VaultStaticSecret, HelmRelease (Flux), Argo.
   - Hướng làm: đọc `status.conditions` (Ready=False) của CR qua CRD store, rồi nối CR với Service và workload bằng label hoặc ownerRef.
4. Timeline chỉ có khoảng 1 giờ (Events). Muốn có lịch sử dài hơn thì phải tự ghi lại snapshot định kỳ (ví dụ vào storage cục bộ).
5. Nhóm issue theo namespace khi cùng loại "missing reference" (thiết kế có incident kiểu "hanas references things that don't exist"); hiện mỗi cụm liên kết là một incident riêng.
6. Bản thiết kế nằm ở artifact "Freelens — theme mới" (Design), gồm các board `ServiceMap`, `ServiceMapPods`, `ServiceMapHealth`, `Topology`: https://claude.ai/artifact/3w2yrNPcpersgSL3DKqENk

## 8. Quy tắc phải giữ

- **Không đọc hay hiển thị** `.env*`, `.envrc`, `.npmrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`.
- **Không dùng lệnh git phá dữ liệu** như `git checkout -- .` hay `reset --hard`. Không xoá file của người dùng khi chưa hỏi.
- **Không push** khi người dùng chưa đồng ý. Không bao giờ dùng hay nhập admin key của APISIX.
- **Commit message:** viết câu tiếng Anh rõ ràng, rồi kết thúc bằng:
  ```
  Co-Authored-By: <model của agent> <noreply@anthropic.com>
  ```
- **Pre-commit hook** chạy trunk check; phải pass.
