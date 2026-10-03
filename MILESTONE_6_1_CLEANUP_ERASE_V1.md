MILESTONE 6.1 — CLEANUP ERASE V1
0. Execution directive
你正在现有的 图片合成工具 / auraplex-product-image-generator 项目中实施本阶段功能。
本阶段只实现非破坏式手动 Cleanup Erase V1。
已经确定的架构决策：
- Erase V1：GO。
- Repair experiment：留到后续独立阶段。
- Production Repair：在实验通过前 NO-GO。
- 不重新设计现有编辑器，不改变现有产品处理流程。
- 保留当前已经工作的功能、布局交互和导出行为。
- 不把本阶段扩大成智能去水印、图像修复或部署项目。
先阅读项目资料并检查实际代码，再实施。资料与代码不一致时，应明确报告差异，不得把未经核实的状态当作事实。
1. Current State / Preconditions
1.1 项目位置
预期项目目录：
C:\Users\25795\Documents\ChatGPT\工作\auraplex-product-image-generator
首先确认实际目录、Git 根目录和项目结构。
1.2 开始前必须阅读
- 项目适用的 AGENTS.md。
- 项目内的 SPEC.md；如果不存在，检查用户之前提供的：
  C:\Users\25795\Desktop\SPEC.md。
- 当前 README、依赖清单、测试配置。
- 与 Cleanup 集成直接相关的编辑器、图片状态、主体选择、图片加载和导出代码。
历史 Milestone 文档用于理解现状，不授权执行本任务范围之外的功能。
1.3 优先检查的现有代码
文件名可能随项目演进变化，以实际代码为准：
frontend/components/EditorClient.tsx
frontend/components/CanvasPreview.tsx
frontend/lib/types.ts
frontend/lib/subjectSelection.ts
核实以下评审发现是否仍然成立：
1. 产品图片内容与 placement 分开存储。
2. 产品 placement 包含 x / y / width / height。
3. 用户缩放可能已经折算进 placement 宽高。
4. updateSources() 的普通刷新路径会触发自动排版。
5. 产品列表会从 source state 重新派生。
6. 现有导出等待逻辑是否仅检查加载数量，而没有检查图片内容版本。
不要未经检查就按旧文件结构修改。
1.4 基线检查
实施前：
- 记录 Git branch、status 和已有修改。
- 确认实际包管理器和可用检查命令。
- 记录已有失败，避免将旧问题归因于本阶段。
- 不安装不相关依赖，不升级整个项目。
Windows PowerShell 中需要时使用 npm.cmd，不要为了运行 npm 修改系统执行策略。
2. Goal
用户可以选择一个产品对象，打开 Cleanup 编辑器，使用手动笔刷把指定像素擦成透明。
整个流程必须满足：
- 非破坏式。
- 可撤销。
- 可恢复到 processed base。
- Apply 前不改变主画布。
- Apply 后不移动或缩放产品。
- 不改变图片原始处理尺寸。
- 不影响其他产品、文字、Logo 或辅助图片。
- 导出读取最新已应用版本。
Erase 的含义是删除像素可见性，不是恢复被遮挡内容。
3. Scope
3.1 本阶段允许实现
- 单个产品的 Cleanup 入口。
- 独立 Cleanup modal/editor。
- 透明棋盘格背景。
- 手动圆形硬笔刷。
- 笔刷大小调整。
- 产品图片坐标下的 mask。
- 最近 20 笔 Undo。
- Reset Cleanup。
- Apply。
- Cancel。
- 一级 Undo Last Apply。
- 小型 product content version override。
- 图片版本加载与导出同步。
- 必要的单元测试、集成测试和浏览器验证。
适配不同窗口大小是必需的；自由缩放、平移等高级编辑能力不是本阶段必需项。若复用现有缩放能力，必须正确处理坐标映射。
3.2 明确禁止实现
- OpenCV。
- Telea。
- NS。
- LaMa。
- Repair API。
- AI inpainting。
- OCR。
- Automatic watermark detection。
- 自动删除疑似水印或小连通域。
- 自动推断产品轮廓。
- 自动补全孔洞、边缘或机械结构。
- LAN deployment。
- 新的云端图像服务。
- 新的数据库或持久化历史系统。
- 无限撤销历史。
- 新的裁剪、重抠图、主体识别流程。
不为未来 Repair 提前安装模型、添加空接口或搭建推理基础设施。
4. Architecture constraints
采用对现有项目最小的增量改动：
- Cleanup Erase 在浏览器完成。
- Konva 可用于交互和显示。
- 产品原尺寸像素与 mask 是最终输出依据。
- 不需要新增后端接口。
- 不修改现有后端图像处理逻辑。
- Cleanup 状态与主画布 placement 分离。
- 主画布与导出使用同一套产品内容版本解析规则。
避免把全部实现堆进现有大组件。可以增加小型、职责明确的：
- Cleanup editor 组件。
- mask／笔画处理工具。
- Cleanup state／版本管理工具。
- 图片加载版本同步逻辑。
不做与本阶段无关的组件重构。
优先复用现有依赖。若原生图像处理链不能满足像素保真要求，只允许引入有明确必要性的轻量前端 PNG 工具，并说明原因、体积和许可；不得因此引入图像修复框架。
5. Erase behavior
5.1 基本语义
对当前工作图片及二值 mask：
mask 内：alpha = 0
mask 外：alpha 保持原值
要求：
- 只改变 alpha。
- 不主动修改 RGB。
- 不填充白色。
- 不模糊。
- 不做内容生成。
- 不重新运行背景移除。
- 不重新裁剪透明边距。
- 重复擦同一区域不产生额外副作用。
5.2 用户提示
Cleanup 界面明确说明：
Erase 会把选中区域变透明，不会修复被水印遮挡的产品内容。

擦到产品内部也会产生透明缺口。本阶段不自动判断笔画是否安全，不声称能保护机械结构。
5.3 空操作与整图擦除
- 没有有效变化时，不创建新内容版本，不覆盖 Undo Last Apply。
- 擦除已经完全透明的区域属于无有效变化。
- 如果工作结果完全透明，Apply 前要求用户明确确认。
- 不自动替用户恢复或改变笔画。
6. Product-image coordinate handling
Cleanup 使用被选产品图片自身的：
W × H 源像素坐标
不是：
1000 × 1000 主画布坐标
必须正确处理：
- modal 中的图片偏移。
- fit-to-view 缩放。
- 若存在，用户缩放和平移。
- 浏览器 CSS 尺寸。
- devicePixelRatio。
坐标映射原则：
图片坐标 = Cleanup 显示变换的逆变换 × 指针坐标
禁止：
- 使用主画布 placement 作为笔画坐标。
- 把设备像素比重复乘入坐标。
- 把显示尺寸 mask 当成源尺寸 mask。
- 根据当前窗口尺寸永久改变图片分辨率。
笔刷在界面显示的尺寸与实际擦除范围必须一致。一次笔画期间应保持明确、稳定的源像素半径。
超出图片范围的笔画部分裁掉。
7. Mask / brush implementation
7.1 Mask
- mask 分辨率始终为 W × H。
- 使用单通道或等价的紧凑二值表示。
- 未选中为 0，选中为 1 或 255。
- 多笔覆盖取并集。
- 不通过反复降低 alpha 来实现擦除。
7.2 Brush
V1 只需要：
- 圆形硬笔刷。
- 可调整大小。
- 清楚的笔刷光标。
- pointer down／move／up 完整笔画。
- 连续线段或等价插值，避免快速移动产生空隙。
处理 pointer capture、离开编辑区域和 pointer cancel，避免“松手后仍然绘制”。
不增加笔刷硬度、压力感应、羽化或复杂混合模式。
7.3 显示与最终输出
可平滑显示笔刷覆盖层，但不能因此使最终 mask 变成不受控的半透明擦除。
最终结果必须按原尺寸像素生成，不能通过截取 modal、缩放预览或主画布截图生成。
注意浏览器 Canvas 的 premultiplied alpha 和 PNG 往返可能影响半透明像素。必须用像素测试验证实际处理链，不得仅以“肉眼看起来相同”代替保真检查。
8. Undo / Reset / Apply / Cancel
8.1 Undo
- 每次完整笔画对应一个 Undo 单位。
- 保留最近 20 笔可撤销历史。
- 使用笔画／mask 历史，不为每一笔保存完整 RGBA 位图。
- 超过 20 笔后，可把较早笔画合并为 mask checkpoint。
- Undo 不修改主画布。
- 不要求实现 Redo。
- 没有可撤销笔画时禁用按钮。
8.2 Reset Cleanup
Reset 的含义是：
将本次工作图恢复到当前产品对应的 processed base。

不是恢复到：
- 原始未抠图上传文件。
- 打开 modal 时的 applied image。
- 当前 session 第一笔之前但仍保留旧 Cleanup 的版本。
Reset：
- 只更新 modal 内 draft。
- 清空本次笔画和笔画 Undo。
- 尚不影响主画布。
- 用户必须 Apply 才提交。
- Cancel 后主画布仍为进入 modal 前的版本。
如果当前 applied image 已有 Cleanup，Reset 后 Apply 应构成一次有效提交，并可通过 Undo Last Apply 恢复 Reset 前的版本。
8.3 Apply
Apply 时：
1. 固定当前编辑对象和内容版本。
2. 生成原尺寸 PNG。
3. 校验尺寸与透明度规则。
4. 成功解码新图片。
5. 再原子性提交内容版本。
6. 保留提交前的 applied image，供一级 Undo Last Apply 使用。
7. 不改变任何 placement。
8. 清理不再需要的临时资源。
处理期间防止重复提交。
生成、解码或版本校验失败时，不修改主画布，不丢弃用户当前 draft。
8.4 Cancel
Cancel、关闭按钮和 Escape：
- 丢弃全部未应用 draft。
- 不改变 applied image。
- 不改变 placement。
- 不改变 Undo Last Apply。
- 正确释放 session 临时资源。
禁止出现点击弹窗外部就静默 Apply 的行为。
9. Undo Last Apply
每个产品分别保留一级 Undo Last Apply。
语义：
- 一次有效 Apply 前，将当前 applied image 保存为 previous applied。
- 点击 Undo Last Apply，将当前内容恢复为 previous applied。
- 消耗该一级撤销记录，不把按钮变成无限前后切换。
- 不要求 Redo Last Apply。
- 不移动、不缩放、不重新排版产品。
- 必须走与 Apply 相同的内容版本加载及导出同步流程。
无有效变化的 Apply 不覆盖旧撤销记录。
重新处理产品或 generation 改变后，旧 Undo Last Apply 不得用于新图片。
为避免会话基准冲突，Cleanup modal 打开期间，不允许从外部同时执行该产品的 Undo Last Apply。
10. Non-destructive state model
最小状态应明确区分：
状态	责任
Original source	原始上传文件，Cleanup 不覆盖
Processed base	本轮处理生成的基础产品 PNG，Cleanup 不覆盖
Applied image	主画布当前正式使用的内容
Session entry	打开 modal 时的版本快照／引用
Working draft	当前会话的基准图与 mask
Previous applied	一级 Undo Last Apply 的目标


要求：
- draft 与 applied 分离。
- 原始文件、processed base 不被就地修改。
- state 中保留必要的资源所有权和版本信息。
- 不要求刷新浏览器后恢复 Cleanup。
- 不引入数据库。
- 不保存无限的 PNG 快照。
- React state 不必在每个 pointer move 复制整张像素数组；避免不必要的全树重渲染。
11. Product content version override
实现一个小型、统一的产品内容覆盖机制。
建议身份至少包含：
asset ID + processing generation
并为每次已提交内容变更维护 revision。
generation 表示本轮抠图／主体处理生成的图片身份。重新处理同一上传文件，即使复用了相同 asset ID，也不能自动继承旧 Cleanup。
统一解析规则：
存在当前 generation 的有效 override
→ 使用 override

否则
→ 使用当前 processed base
必须覆盖：
- 主画布显示。
- 从 source state 重新派生产品列表。
- Cleanup 重新打开。
- 导出所读取的产品图片。
禁止仅临时修改 products[] 中某个 URL，却让下次 source state 派生恢复旧内容。
不得依靠文件名或产品数组索引关联 Cleanup。
whole image 与不同 subject candidate 应具有独立身份，不能共享 mask。
同 generation 的 source state 重新派生，不得丢失有效 override。
产品删除、主体失效或重新处理后，清理已经不可达的 override 和对应资源。仍被当前 source／candidate 引用的版本，不应仅因暂时未显示就被误释放。
12. 禁止触发 auto-layout
以下操作不能触发自动排版：
- 打开 Cleanup。
- 绘制笔画。
- Undo。
- Reset Cleanup。
- Apply。
- Cancel。
- Undo Last Apply。
- 新内容版本完成解码。
Cleanup Apply 不能经过会重新触发 auto-layout 的普通 updateSources() 路径。
先检查现有调用链，选择专用内容更新入口，或在现有结构中增加明确不会触发布局的内容更新分支。
不能为了 Cleanup 改坏原有 Auto Layout 或 Reset Layout。
用户主动点击现有布局按钮时，保留原行为；这些按钮不能撤销 Cleanup 像素内容。
13. 保持 x / y / width / height
Apply 和 Undo Last Apply 前后必须保持：
product ID
x
y
width
height
layer order
selection identity
manual placement
若存在独立的 rotation、scale 或其他变换字段，也必须原样保留。
若缩放已折算进 width／height：
- 不重复应用 scale。
- 不重新按图片 natural size 初始化 placement。
- 不因为图片 URL 改变而重新适配产品大小。
其他产品的 placement 与内容版本不得变化。
14. 保持原 processed image 尺寸，不重新 crop
本阶段采用固定尺寸策略：
Cleanup output width  = processed base width
Cleanup output height = processed base height
即使擦除了图片边缘内容、增加透明边距，也不得：
- 自动裁透明边。
- 重算 bounding box 后缩小 PNG。
- 自动调整产品 placement。
- 自动放大剩余产品。
- 重新采样为 1000×1000。
已有初次处理流程的 crop 行为不在本阶段修改范围内。
Cleanup 必须保留进入本轮处理后的固定图片坐标系。
15. Blob URL 生命周期
明确区分资源所有权：
- 原始／processed base 资源。
- applied 资源。
- previous applied 资源。
- session draft／预览资源。
- 正在被图片加载或导出使用的资源。
要求：
- 不 revoke 仍被任一有效状态引用的 URL。
- Apply 后不能立即 revoke 已转为 previous applied 的旧 URL。
- Cancel 后释放仅属于被取消 session 的资源。
- 后一次 Apply 替换 previous applied 后，释放不再使用的更旧版本。
- 删除产品、generation 失效、组件卸载时回收无引用资源。
- 同一 URL 被多个状态引用时不得提前释放。
- 不 revoke 不属于本模块管理的远程 URL。
采用符合项目现状的明确所有权／引用管理，不需要引入通用资源管理框架。
验证多次打开、取消、应用、撤销、删除后，不出现无限累积的 Blob URL。
16. Export 必须读取最新 Cleanup 版本
复用当前导出实现，不新增另一套导出系统。
必须保证：
- 导出读取当前 applied revision。
- 未 Apply 的 draft 不进入导出。
- Apply 后立即导出，不得输出旧 PNG。
- Undo Last Apply 后导出恢复后的 PNG。
- Reset 后 Apply，导出 processed base。
- 图片尺寸和主画布布局保持一致。
- Cleanup 棋盘格、笔刷、mask、辅助覆盖层不进入导出。
不能仅以“加载图片数量等于产品数量”判断导出就绪。
应基于产品身份与内容 revision，确认当前期望版本：
1. 已成功加载／解码。
2. 已进入导出实际读取的渲染状态。
尚未就绪时，显示短暂准备状态或等待；失败时明确提示，不得静默导出旧版本。
导出开始时固定一份一致的内容版本快照，或使用等价机制，避免导出过程中混入不同 revision。
17. 1–5 products isolation
最多 5 个产品，每个产品分别拥有：
- processed base。
- generation／revision。
- applied override。
- previous applied。
- Cleanup session 基准。
同一时间只打开一个 Cleanup session。
必须验证：
- 清理产品 A 不改变 B–E。
- A 的 Undo Last Apply 不影响其他产品。
- 删除 A 不破坏 B 的资源。
- 重新处理 A 不复用 A 的旧 mask。
- 调整产品顺序不串用 Cleanup。
- 选择不同 subject candidate 不串用 Cleanup。
- 不按数组索引保存清理状态。
Cleanup 入口仅作用于产品图片，不扩展到 Logo、辅助图片或文字对象。
18. Error handling
必须处理：
- 图片无法加载或解码。
- PNG 生成失败。
- 图片尺寸无效。
- 图片过大或内存分配失败。
- Canvas／像素读取失败。
- Apply 过程中编辑对象失效。
- generation／revision 已变化。
- modal 关闭后异步任务才返回。
- pointer cancel。
- 重复点击 Apply。
- 只有透明区域被选中。
- 整图被擦成透明。
共同原则：
- 不破坏当前 applied image。
- 不改变主画布 placement。
- 错误有可理解的提示。
- 能继续编辑时保留 draft。
- Cancel 始终能够退出未提交操作。
- 过期异步结果不能回写。
- 不静默降低分辨率。
- 不调用后端或云端兜底。
若需要新增源图像素上限，依据现有上传限制及实测确定，并明确报告；不得使用没有说明的魔法值悄悄拒绝图片。
19. Tests
按项目现有测试体系增加测试，不只测试按钮是否存在。
19.1 像素与 mask
至少覆盖：
- mask 内 alpha 为 0。
- mask 外 alpha 原样保持，包括半透明值。
- RGB 不被擦除算法修改。
- PNG 输出尺寸保持 W×H。
- 重叠笔画的并集。
- 快速移动笔画连续。
- 越界裁切。
- 空 mask。
- 已透明区域。
- 完全擦除。
使用带已知 RGB／alpha 值的小型 fixture。
对实际 PNG 生成、解码链做往返验证，特别检查半透明边缘。不能通过忽略半透明像素、放宽断言或只测纯不透明图片隐藏问题。
19.2 坐标
至少覆盖：
- 不同显示缩放比例。
- 图片在 modal 中存在偏移。
- 非正方形产品图。
- 高 DPR 场景。
- 如支持 zoom／pan，其逆变换正确。
- 主画布产品尺寸变化不影响 Cleanup 源像素坐标。
19.3 会话与撤销
至少覆盖：
- Undo 一笔。
- 20 笔撤销边界。
- 超过 20 笔后 checkpoint 正确。
- Reset 恢复 processed base。
- Reset 后 Cancel。
- Reset 后 Apply。
- Apply 后重新打开。
- 一级 Undo Last Apply。
- 无操作 Apply 不覆盖 previous applied。
- Cancel 不修改 applied。
19.4 集成与版本
至少覆盖：
- Apply 前后 placement 完全相同。
- Apply 不调用自动排版。
- Undo Last Apply 不调用自动排版。
- source state 重新派生仍使用 override。
- generation 更新不套用旧版本。
- 过期异步回调不能提交。
- 产品删除后不回写。
- 1–5 产品互相隔离。
- Blob URL 不提前释放，也不无限泄漏。
- 相同图片数量但 revision 更新时，导出不会误判就绪。
- 导出只读取最新已应用版本。
19.5 项目检查
完成后运行实际存在的：
- lint。
- type-check。
- tests。
- production build。
不要假设脚本名称；先查看项目配置。
新测试和现有相关测试必须通过。区分：
- 本阶段引入的问题。
- 实施前已存在的问题。
- 环境限制导致无法执行的检查。
不通过删除测试、降低断言或更改无关配置制造“全绿”。
20. Browser verification
除自动测试外，实际在浏览器验证。
至少完成：
1. 上传并显示一个产品。
2. 手动拖动、缩放到非默认布局。
3. 打开 Cleanup，在明显可辨识的小区域擦除。
4. 确认主画布在 Apply 前未变化。
5. 验证 Undo。
6. Apply，确认产品位置、大小和图层顺序未变。
7. 立即导出并检查实际导出图片。
8. 重新打开 Cleanup，验证从当前 applied 开始。
9. Reset 后 Cancel，确认没有提交 Reset。
10. Reset 后 Apply，再 Undo Last Apply。
11. 使用 5 个产品验证隔离。
12. 检查 source 刷新／重新处理后的版本行为。
13. 调整窗口大小，检查坐标和界面可用性。
14. 检查浏览器控制台错误。
15. 重复打开、取消、应用，检查资源释放行为。
使用透明 PNG、非正方形图片和包含半透明边缘的测试图。
验证导出文件本身，而不只是主画布截图。保存必要的验证证据，但不要把大量临时截图或生成文件加入 Git。
若当前环境无法实际浏览器验证，明确写“未验证”，不能用单元测试通过替代端到端完成声明。
21. Failure / STOP rules
以下情况应暂停受影响的实现，保留已有工作并报告：
- 无法可靠识别产品内容与 placement 的分离边界。
- Cleanup 集成会要求大范围重写现有编辑器。
- 必须覆盖用户已有修改才能继续。
- 无法保证 source state 重新派生后保留 Cleanup。
- 无法保证 generation 隔离。
- 无法保证输出尺寸和 alpha 规则。
- 无法保证 Apply 不触发自动排版。
- 无法保证导出读取当前 revision。
- 需要新增后端服务、模型或禁止的依赖。
- 实际代码与评审前提存在会影响方案的重大冲突。
先穷尽安全、局部的实现方式。确需改变架构边界时，说明：
1. 发现了什么。
2. 相关代码证据。
3. 为什么当前方案受阻。
4. 最小替代方案。
5. 需要用户决定什么。
禁止自行扩大范围。
对一般可修复的代码或测试失败，应继续在本阶段范围内修复；STOP 不是遇到第一条错误就放弃。
22. Git rules
开始前检查：
git status
git branch
git diff
确认真实 Git 根目录。该项目可能位于更大的父级工作区，不能把父目录其他项目纳入改动。
规则：
- 保留用户已有修改。
- 不运行 git reset --hard。
- 不运行 git checkout -- 覆盖文件。
- 不删除未知文件。
- 不执行全仓库格式化。
- 不使用 git add . 收集无关文件。
- 不提交模型、临时图片、构建输出、虚拟环境或依赖目录。
- 不自动 commit。
- 不自动 push。
- 不 merge。
- 不修改 remote 或 upstream 分支。
- 不未经请求切换分支。
本任务完成后保留可审查的局部改动，并提供变更文件清单。若当前项目尚未被 Git 跟踪，明确报告，不自行把整个项目加入版本控制。
23. Final report format
最终报告必须包含以下部分：
A. Result
选择一个：
COMPLETE
PARTIAL
BLOCKED
并简要说明是否达到 Erase V1 的所有验收条件。
B. Implemented
列出实际完成的功能，不列尚未实现的计划。
C. Architecture
说明：
- product-image 坐标处理。
- mask 与 20 笔 Undo。
- Reset／Apply／Cancel。
- Undo Last Apply。
- override、generation 与 revision。
- 如何避开 auto-layout。
- 如何保留 W×H 和 placement。
- Blob URL 所有权。
- 最新版本导出同步。
D. Changed files
列出修改和新增文件及其职责。
单独说明新增依赖；没有则写“无”。
E. Checks
按表格报告：
检查 | 实际执行命令/方法 | 结果 | 备注
包含：
- lint。
- type-check。
- tests。
- build。
- browser verification。
- 导出文件验证。
不得把未运行项目写成 PASS。
F. Acceptance evidence
明确报告是否验证：
- mask 内 alpha 为 0。
- mask 外 alpha 保持原值。
- 半透明边缘保真。
- W×H 不变。
- x／y／width／height 不变。
- 没有触发自动排版。
- source 重新派生不丢失 Cleanup。
- Undo Last Apply。
- 最新版本导出。
- 1–5 产品隔离。
- Blob URL 生命周期。
G. Not implemented
明确确认本阶段没有实现：
OpenCV
Telea
NS
LaMa
Repair API
AI inpainting
OCR
Automatic watermark detection
LAN deployment
H. Known limitations / Remaining issues
说明实际限制、未验证项和现有旧问题，不以“已完成”掩盖未通过的条件。
I. Git status
说明：
- 当前分支。
- 是否存在实施前已有修改。
- 本阶段变更范围。
- 未 commit、未 push、未 merge。
J. Next-stage boundary
仅说明：
Repair 技术实验属于后续独立阶段，本次未开始。Production Repair 仍需实验通过后另行授权。

24. Completion gate
只有以下条件全部满足，才能标记 COMPLETE：
- 手动 Erase 可用且非破坏式。
- Undo／Reset／Apply／Cancel 语义正确。
- 一级 Undo Last Apply 可用。
- Cleanup 使用产品源像素坐标。
- 保留 processed image 的 W×H。
- 不触发自动排版。
- 不改变产品 placement。
- override 不因同 generation 的状态派生而丢失。
- generation 变化不会继承旧 Cleanup。
- 1–5 产品正确隔离。
- Blob URL 生命周期正确。
- 导出读取最新已应用内容。
- 必需检查通过，浏览器与导出验证完成。
- 未实现任何本阶段禁止功能。
严格停留在 MILESTONE 6.1 — CLEANUP ERASE V1。不要开始 Repair。