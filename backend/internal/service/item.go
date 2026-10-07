package service

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5"

	"lostfound/internal/apperr"
	"lostfound/internal/model"
	"lostfound/internal/repo"
)

// ItemStore 是帖子业务需要的全部持久化能力。
//
// 窄接口的理由和 UserStore 一样，但这里更实际：M2 的验收判据里
// 「非本人改他人帖得 FORBIDDEN」「改自己一条 closed 状态的帖子 → 成功」
// 这两条是**权限规则**，它们必须能在不起数据库的情况下被测（§10 第①层），
// 否则每加一条权限分支都要跑一次完整迁移，而且失败时看不清是权限错了还是数据脏了。
type ItemStore interface {
	Create(ctx context.Context, p repo.NewItemRow) (*model.ItemDetail, error)
	GetByID(ctx context.Context, id int64) (*model.ItemDetail, error)
	Update(ctx context.Context, id int64, p repo.UpdateItemRow) (*model.ItemDetail, error)
	SetStatus(ctx context.Context, id int64, status string) error
	List(ctx context.Context, f repo.ListFilter) ([]model.ItemDetail, int, error)
	ListImages(ctx context.Context, itemID int64) ([]model.ItemImage, error)
	ImageWithOwner(ctx context.Context, imageID int64) (model.ItemImage, int64, error)
	DeleteImage(ctx context.Context, imageID int64) (string, error)

	// 下面两个是**收 pgx.Tx** 的写入原语，只有 #16 的 admin 分支会用（M6）。
	//
	// 它们和上面那八个的区别不是「多一个参数」，而是**谁拥有事务**：上面八个自己
	// Begin/Commit，一次调用就是一次独立的写；下面两个必须被夹在调用方的事务里，
	// 于是「改数据行」和「写留痕那一行」能落在同一个事务中（§12 判据 ④：
	// 不带理由时帖子一条都没被改）。
	//
	// 把它们列进同一个接口而不是另开一个窄接口，是因为用它们的正是本服务自己 ——
	// ItemStore 的语义本来就是「帖子业务需要的全部持久化能力」，
	// 而帖子业务的写入在 M6 之后确实包含「在别人的事务里写」。
	// （#17 的 admin 分支反而不在这里：它整段走 ItemGovernance，见下面那个接口。）
	UpdateTx(ctx context.Context, tx pgx.Tx, id int64, p repo.UpdateItemRow) (int64, error)
	ReplaceImagesTx(ctx context.Context, tx pgx.Tx, itemID int64, paths []string) error
}

// ItemGovernance 是 #17 那个「admin 删别人的帖子」分支需要的能力。
//
// 这个接口只有一个方法，而它**不是**读写 items 的原语 —— 它是一次完整的治理动作：
// 下架 + 留痕 + 给作者发那条带理由的通知。#43 批量下架、#49 的连带下架、#17 的 admin
// 分支三处必须是同一份实现（否则「从后台删的会通知、从帖子页删的不通知」）。
// 那份实现住在 service.Moderation 里，所以这里是一个**服务依赖服务**的接缝，
// 而不是往 ItemStore 里再加一个 SetStatusTx：
// 后者会让帖子服务自己拼出一次「删帖但没留痕」的动作，而那正是 M6 要消灭的东西。
//
// 反过来 Moderation 不依赖 Item 服务，所以这条边不会构成环。
//
// ⚠ 收 pgx.Tx：调用方（Item 服务）开事务、提交事务，这里只负责在那半个事务里
// 把三件事写完。留痕和业务同事务没有第二种写法。
type ItemGovernance interface {
	TakedownByAdmin(ctx context.Context, tx pgx.Tx, adminID, itemID int64,
		reason string) (taken, notified int, err error)
}

// TakedownLookup 是「向作者解释这条帖子为什么不见了」需要的**只读**能力。
//
// 它的唯一实现是 repo.AdminAction.LatestTakedowns（一次查一批，返回 map）。
// 之所以单独开一个接口而不是塞进 ItemStore：ItemStore 的语义是「帖子业务需要的
// 持久化能力」，而这件事的数据根本不在 items 表里 —— 它在 admin_actions 那本登记簿里，
// 是**治理**的记录。把它单列出来，读这段代码的人就不会以为 items 上有一列 reason。
//
// ⚠ 接口里只有读，没有任何写。所以帖子服务在类型层面就写不出「解释的时候顺手改一下台账」，
// 而台账唯一的写入口仍然是 service/adminlog.Record（收 pgx.Tx，和业务同事务）。
type TakedownLookup interface {
	LatestTakedowns(ctx context.Context, itemIDs []int64) (map[int64]repo.TakedownInfo, error)
}

// DictLookup 是发帖/改帖时校验分类与地点需要的能力。
//
// 单独一个接口而不是复用 DictTrees：建树要的是全量行，校验要的是单行点查，
// 两者的形状完全不同。合在一起的话，为校验写的 fake 就得实现一个它用不上的全量查询。
type DictLookup interface {
	GetCategory(ctx context.Context, id int64) (*model.Category, error)
	GetLocation(ctx context.Context, id int64) (*model.Location, error)
	CountActiveChildren(ctx context.Context, id int64) (int, error)
}

// MatchRunner 是发帖 / 改帖之后那一步匹配需要的能力。
//
// ⚠ 两个签名里**都没有 error**，这不是遗漏，是 §5.8「匹配失败绝不影响发帖成功」
// 在类型层面的落实：接口里没有 error，Create/Update 想往上抛也抛不了，
// 所有失败只能在 Match 内部变成日志。将来若真需要「匹配失败要报错」，
// 必须先改这个签名 —— 而改签名会撞上所有 fake，改的人就会停下来想清楚
// 「为了一个增值功能让用户重发一遍帖子」是不是他要的。
//
// 返回值是指针而不是值，含义见 Match.OnCreated。用接口而不是直接用 *Match，
// 是为了给 M3 的集成测试留一个能数调用次数的接缝。
type MatchRunner interface {
	OnCreated(ctx context.Context, target *model.ItemDetail) (*[]MatchHit, *int)
	OnUpdated(ctx context.Context, target *model.ItemDetail)
}

// ItemLookup 是「只要按 id 取一条帖子」的那些服务共用的接缝。
//
// 三处用它，且三处的判断都只依赖帖子本身的三个属性（类型、状态、作者）：
//   - #20 匹配（Match.OnCreated / Matches）—— 要目标帖的全部字段
//   - #21 解锁、#22 名单（Contact）—— 要类型、状态、user_id
//   - #41 举报（Report）—— 要存在性和状态
//
// 为什么不直接用 ItemStore（它有八个方法）：给这三个服务写单测的 fake
// 就得实现六个永远用不到的方法，那种 fake 会让人干脆不写这个测试（§10 第①层的原话）。
// 反过来才是关键：**接口里没有写方法，服务就越权不了**。
// Contact 服务拿不到 Create/Update/Delete，所以「解锁时顺手改一下帖子状态」
// 这种代码在类型层面就写不出来。
type ItemLookup interface {
	GetByID(ctx context.Context, id int64) (*model.ItemDetail, error)
}

// Item 是帖子的业务规则：校验、权限、contact 可见性、软删语义、图片删除。
type Item struct {
	// tx 只为 #16/#17 的 admin 分支存在：那两条路径要把「改数据行 + 写留痕 + 发通知」
	// 夹进同一个事务，而事务只能由最外层那个服务开（§12 M6「留痕和业务同事务」）。
	// 帖主自己的改/删不用它 —— 那些路径上一行 admin_actions 都不写，没有需要同生同死的东西。
	tx      TxStarter
	items   ItemStore
	gov     ItemGovernance
	dict    DictLookup
	uploads *Upload
	match   MatchRunner
	// contacts 只为 #15 的第三条可见性规则存在（「已解锁过就放行」），只读、不写。
	// M2 那版这里什么都没有，因为当时全站没有任何代码能往 contact_views 写行；
	// M4 加了 #21 之后，这一格必须接上，否则 found 帖的 contact 对全世界永远是 null，
	// 而定位原则 2 说的恰恰是「联系方式是能联系到本人的唯一选项」。
	contacts ContactViewLookup
	// takedowns 只为两件解释性的读存在：#15（作者读自己被下架的那条）和
	// #19（作者翻「我的发布」里 deleted 那一栏）。它不写任何东西，
	// 也不参与任何业务判断 —— 少了它这两个端点**照样返回 200**，
	// 只是那几行少了「为什么」这句话。所以传 nil 是合法的、也是安全的：
	// 装配漏了它不会 panic，只会退回到 M6 那个「看得见被删、说不出原因」的状态。
	takedowns TakedownLookup
	logger    *slog.Logger
}

// NewItem 的依赖顺序就是上面那条链：tx → items → gov → dict → uploads → match → contacts → takedowns。
//
// ⚠ gov 是 M6 加的第 3 个参数，装配时必须传**已经构造好的 Moderation**（router.go 里
// 那一行的顺序因此动了）。传 nil 不会在启动时报错，只会在 admin 删别人帖子时 panic，
// 而那条路径一个月走不了几次 —— 所以这里不假装能兜住它，靠 §12 M6 那两条
// 遍历 admin 路由的测试（TestNonAdminBlockedFromAdminRoutes / TestEveryAdminWriteIsLogged）
// 把整条 admin 通道真的走一遍。
func NewItem(tx TxStarter, items ItemStore, gov ItemGovernance, dict DictLookup, uploads *Upload,
	match MatchRunner, contacts ContactViewLookup, takedowns TakedownLookup, logger *slog.Logger) *Item {
	if logger == nil {
		logger = slog.Default()
	}
	return &Item{tx: tx, items: items, gov: gov, dict: dict, uploads: uploads,
		match: match, contacts: contacts, takedowns: takedowns, logger: logger}
}

// ---------- 请求/响应形状 ----------

// CreateItemInput 是 #13 POST /api/items 的输入。
type CreateItemInput struct {
	ItemType string
	ItemFields
	ImagePaths []string
}

// CreateResult 是 #13 的 data。
//
// 后两个字段是**互斥的可选**字段（计划 §4 #13 与「#13 的响应为什么有两个互斥的
// 可选字段」一节）：lost 帖只带 matches_preview，found 帖只带 notified_count。
//
// 两个都是指针而不是「值 + omitempty」，为的是能表达「空数组也要出现」：
//   - MatchesPreview 用值类型 + omitempty 的话，一条都没匹配上时整个键会消失
//     （Go 的 omitempty 把 len==0 的切片也算空），而 §13 验收步骤明确写着
//     库里还没有 found 帖时响应要带 `matches_preview: []` —— 前端要靠「键在但为空」
//     显示「已经登记好了，之后有人发拾物帖匹配上了我们会通知你」，
//     键消失了它就只能显示一个空白区块。
//   - NotifiedCount 用值类型的话 found 帖的 0 和「这不是 found 帖」完全一样，
//     而冒烟场景里「建了一条谁都没匹配上的 found 帖 → notified_count:0」
//     断言的正是「0 出现了」而不是「键消失了」。
type CreateResult struct {
	Item model.ItemView `json:"item"`

	MatchesPreview *[]MatchHit `json:"matches_preview,omitempty"` // 仅 item_type=lost，top 5
	NotifiedCount  *int        `json:"notified_count,omitempty"`  // 仅 item_type=found，被推了 new_match 的 lost 作者数
}

// UpdateItemInput 是 #16 PUT /api/items/:id 的输入。
//
// ImagePaths 是指针切片：nil = 请求里没带这个字段（图片保持原样），
// 空切片 = 明确要求把图片全删掉。理由见 repo.UpdateItemRow 的注释。
type UpdateItemInput struct {
	ItemFields
	ImagePaths  *[]string
	AdminReason string // 仅当操作者是 admin 且不是帖主时必填
}

// StatusResult 是 #18 PATCH /api/items/:id/status 的 data：{id, status}。
type StatusResult struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
}

// ---------- #13 发帖 ----------

// Create 发一条帖子。
//
// 流程刻意是「先全部校验、再写库」：校验分散在写库之后的话，一次失败会留下
// 半条数据（帖子建好了但图片没插上），而那种残留没人会去清。
func (s *Item) Create(ctx context.Context, userID int64, in CreateItemInput) (*CreateResult, error) {
	if in.ItemType != model.ItemTypeLost && in.ItemType != model.ItemTypeFound {
		return nil, apperr.Validation("帖子类型不对",
			apperr.FieldError{Field: "item_type", Msg: "只能是 lost 或 found"})
	}

	norm, err := normalizeItemFields(in.ItemType, in.ItemFields)
	if err != nil {
		return nil, err
	}
	if err := validateImagePaths(in.ImagePaths); err != nil {
		return nil, err
	}
	if err := s.checkDictRefs(ctx, in.CategoryID, in.LocationID); err != nil {
		return nil, err
	}

	d, err := s.items.Create(ctx, repo.NewItemRow{
		ItemType:       in.ItemType,
		UserID:         userID,
		Title:          norm.Title,
		Description:    norm.Description,
		CategoryID:     in.CategoryID,
		LocationID:     in.LocationID,
		LocationDetail: norm.LocationDetail,
		LastSeenAt:     norm.LastSeenAt,
		LostAt:         norm.LostAt,
		FoundAt:        norm.FoundAt,
		Contact:        norm.Contact,
		ImagePaths:     in.ImagePaths,
	})
	if err != nil {
		return nil, err
	}

	// ---- M3：发帖后的匹配，方向由 item_type 决定（§5.8 那张表的落地）----
	//
	// 位置在「帖子已经落库」之后、构造响应之前，且**同步执行**（不开 goroutine）：
	// found 帖的 notified_count 是响应体的一部分，异步就算不出这个数；
	// 而 lost 帖的 matches_preview 是发帖成功页要直接渲染的东西（§2.6.2 第 3 步），
	// 用户点完提交就看到结果，不该等一次轮询。
	//
	// ⚠ 这个调用**不可能往数据库写 posts 以外的东西**：Match.OnCreated 里
	// lost 分支根本不碰 RecordMatches（§4 的实现检查点：matches_preview 分支
	// 不允许出现任何 INSERT）。这一点在 M3 的集成测试里用「发一条 lost 帖之后
	// match_pairs 和 notifications 都是 0 行」钉死。
	preview, notified := s.match.OnCreated(ctx, d)

	s.logger.InfoContext(ctx, "item.create",
		slog.Int64("item_id", d.ID),
		slog.String("item_type", d.ItemType),
		slog.Int64("user_id", userID),
		slog.Int64("category_id", d.CategoryID),
		slog.Int64("location_id", d.LocationID),
		slog.Int("images", len(in.ImagePaths)))

	// 自己的新帖子：联系方式一定可见，不存在「解锁」这回事
	view, err := s.buildView(ctx, d, nil, true)
	if err != nil {
		return nil, err
	}
	return &CreateResult{Item: *view, MatchesPreview: preview, NotifiedCount: notified}, nil
}

// ---------- #15 详情 ----------

// Detail 取一条帖子的详情，按可见性规则决定 contact 给不给。
//
// viewer 是 nil 表示未登录（#15 是公开接口，挂的是 OptionalJWT）。
func (s *Item) Detail(ctx context.Context, viewer *model.User, id int64) (*model.ItemView, error) {
	d, err := s.items.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	if d.Status == model.ItemStatusDeleted && !canSeeDeleted(viewer, d.UserID) {
		// 报 NOT_FOUND 而不是 FORBIDDEN：软删的帖子对外就该是「不存在」。
		// 返回 403 等于确认了「这个 id 曾经有过一条被删的帖子」—— 那是治理信息。
		// 同一条纪律也用在登录接口上（不区分「用户名不存在」和「密码错」）。
		return nil, apperr.NotFound("帖子")
	}

	// admin 也没有额外的联系方式可见性：#15 的规则里没有 admin 分支。
	// 他当然可以从 Adminer 里看到 contact 列，但那是「数据库增删改查」，
	// 走 API 这条路不该给他一个绕过解锁记录的通道 —— 否则 contact_views
	// 这份审计日志就不再完整了（定位原则 5）。
	v, err := s.buildView(ctx, d, viewer, false)
	if err != nil {
		return nil, err
	}

	// 「为什么不见了」这句话只对**作者本人**说（2026-10-07 用户新增的需求）。
	//
	// admin 读同一条帖子时这里**不填**：他不是需要一个说法的人，而 #50 那本登记簿
	// 里本来就有同一句话的完整版（带操作者昵称、带 detail）。两处都给就会出现
	// 「同一个事实两个地方两份」，将来一改一不改就再也对不上了。
	//
	// 排在最后、而且只在 deleted 时发这一次查询：open/closed 的帖子读得最多，
	// 它们一行登记簿都不该扫。
	if d.Status == model.ItemStatusDeleted && viewer != nil && viewer.ID == d.UserID {
		r, err := s.removalFor(ctx, d.ID)
		if err != nil {
			return nil, err
		}
		v.Removal = r
	}
	return v, nil
}

// ---------- #16 改帖 ----------

// Update 改一条帖子。
//
// ⚠ 不能改的两样东西：item_type（请求体里没有这个字段，类型从库里已有的行取）
// 和作者（repo.UpdateItemRow 里压根没有 user_id）。
// 「归属可以转让」是这个系统最不该有的能力，所以它在类型层面就不存在。
//
// found 帖改完会重新跑一次匹配（Match.OnUpdated），lost 帖不会 ——
// 这个不对称是 §5.8 的规矩在改帖上的延续：lost 方向的匹配任何时候都只算不写。
//
// 第三种情况：**admin 改帖一次匹配都不跑**，found 也一样（M6 补的这条分支）。
// 理由见下面那句 ⚠，它和 §5.8 那条「匹配失败不影响发帖」是两件事。
func (s *Item) Update(ctx context.Context, actor *model.User, id int64, in UpdateItemInput) (*model.ItemView, error) {
	d, err := s.items.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}

	asAdmin, err := authorizeItemWrite(actor, d.UserID, in.AdminReason)
	if err != nil {
		return nil, err
	}

	// ITEM_CLOSED 只挡 deleted：open 和 closed 都能改（计划 §8 对这个码的说明）。
	// 理由在那里写得很清楚 —— 匹配候选只看 open，改一条 closed 帖不会污染任何结果；
	// 而「东西已经还回来了，但描述里写错了电话」这种情况必须能改。
	if d.Status == model.ItemStatusDeleted {
		return nil, apperr.NewMsg(apperr.CodeItemClosed, "帖子已被删除，无法修改")
	}

	norm, err := normalizeItemFields(d.ItemType, in.ItemFields)
	if err != nil {
		return nil, err
	}
	if in.ImagePaths != nil {
		if err := validateImagePaths(*in.ImagePaths); err != nil {
			return nil, err
		}
	}
	if err := s.checkDictRefs(ctx, in.CategoryID, in.LocationID); err != nil {
		return nil, err
	}

	// 一条 row 建两次用：帖主自己走 pool 版本的 Update，admin 走同事务那条路（见 updateByAdmin）。
	// 两处传的是**同一个值**，所以「admin 能改的字段」和「帖主能改的字段」不可能在这层走岔。
	row := repo.UpdateItemRow{
		Title:          norm.Title,
		Description:    norm.Description,
		CategoryID:     in.CategoryID,
		LocationID:     in.LocationID,
		LocationDetail: norm.LocationDetail,
		LastSeenAt:     norm.LastSeenAt,
		LostAt:         norm.LostAt,
		FoundAt:        norm.FoundAt,
		Contact:        norm.Contact,
		ImagePaths:     in.ImagePaths,
	}

	var updated *model.ItemDetail
	if asAdmin {
		updated, err = s.updateByAdmin(ctx, actor.ID, id, row, in.AdminReason)
	} else {
		updated, err = s.items.Update(ctx, id, row)
	}
	if err != nil {
		return nil, err
	}

	attrs := []any{
		slog.Int64("item_id", id),
		slog.Int64("actor_id", actor.ID),
		slog.Bool("as_admin", asAdmin),
	}
	if asAdmin {
		attrs = append(attrs, slog.Int64("owner_id", d.UserID), slog.String("reason", in.AdminReason))
		s.logger.WarnContext(ctx, "item.update_by_admin", attrs...)
	} else {
		s.logger.InfoContext(ctx, "item.update", attrs...)
	}

	// ⚠ **admin 改帖不重跑匹配**（计划 §12 那条「#16 改帖时不重跑匹配」）。
	// 理由不是性能：管理员改一个字（补个错别字、改个地点描述）如果触发一轮新匹配，
	// 一批 lost 用户就会收到「有人捡到了你的东西」的通知，而那条帖子的主人**并没有
	// 重新表态** —— 那等于平台替发帖人许诺了一次归属，违反定位原则 1。
	// 反过来说，帖主自己改帖推通知是对的：那次表态是他做的。
	//
	// 顺序：必须在 items.Update 提交之后。台账的外键指向 items(id)，
	// 而 score/breakdown 要按改完的值算；反过来写在事务里，一旦匹配报错就会牵连改帖本身
	// （§5.8 禁止的那种失败传播）。放在提交后，最坏情况是「帖子改好了、通知没发出去」。
	//
	// 传的是**回读出来的那一条**而不是请求体：类型、状态、字典祖先列都只有库里有，
	// 而匹配方向（found 才写库）和 closed 不通知这两道门槛都在 Match.OnUpdated 里判。
	if !asAdmin {
		s.match.OnUpdated(ctx, updated)
	}

	// 操作者刚刚把 contact 作为请求体的一部分提交上来，所以响应里一定回给他 ——
	// 否则他改完自己（或别人）的帖子，看到的却是一个 null，会以为改丢了。
	return s.buildView(ctx, updated, nil, true)
}

// updateByAdmin 是 #16 的 admin 分支：改字段 + 重建图片 + 写留痕，三件事夹在同一个事务里。
//
// 为什么单独立一个方法而不是在 Update 里 if 一下：Update 已经有五步校验，
// 再叠一段事务闭包就没人能一眼看出**哪几步在事务里**了。而「留痕和业务同事务」
// 这条纪律恰恰要求它写成一段看得出边界的代码（§12 M6 判据 ④ 断言的就是这条边界）。
//
// 帖主自己改帖走的是另一条路（`s.items.Update`，那个方法自己 Begin/Commit），
// 那条路上**一行 admin_actions 都不写**：自己的帖子自己改，不需要向任何人交代。
//
// ⚠ 留痕里那个 owner_id 来自 UpdateTx 的 RETURNING，不是来自请求体，也不是来自
// 事务开始前那次 GetByID：它是「这一行真正的作者」在这一刻的事实。
// 那一次点查当然也读到了 user_id，但读的是**可能被并发改过之前**的值 ——
// 而留痕是这张表唯一的问责入口，它只能写库里认定的那个作者。
func (s *Item) updateByAdmin(ctx context.Context, adminID, id int64, row repo.UpdateItemRow, rawReason string) (*model.ItemDetail, error) {
	// 长度在开事务**之前**查。authorizeItemWrite 只保证了非空，没保证 ≤500
	// （admin_actions.reason 的宽度）；放任超长串走到 Record 那一道，
	// 得到的是「开了事务、改了字段、又被回滚」，而在这里查得到的是带 field 的 VALIDATION，
	// 一次数据库往返都不发。
	reason, err := requireReasonField(adminReasonField, rawReason)
	if err != nil {
		return nil, err
	}

	var ownerID int64
	if err := runInTx(ctx, s.tx, "service.Item", func(tx pgx.Tx) error {
		var err error
		ownerID, err = s.items.UpdateTx(ctx, tx, id, row)
		if err != nil {
			return err
		}
		// ImagePaths == nil 表示「这次不改图片」，连 DELETE 都不发 —— 和 pool 版本同一个规矩。
		if row.ImagePaths != nil {
			if err := s.items.ReplaceImagesTx(ctx, tx, id, *row.ImagePaths); err != nil {
				return err
			}
		}
		return Record(ctx, tx, adminID, model.ActionItemEdit, model.TargetItem,
			id, reason, map[string]any{"owner_id": ownerID})
	}); err != nil {
		return nil, err
	}

	// 回读放在事务**外面**：响应要的那份形状（分类名、地点名、作者昵称、封面）
	// 只有 itemDetailCols 那一串 JOIN 给得出，而它此刻读到的已经是提交后的值。
	return s.items.GetByID(ctx, id)
}

// ---------- #17 删帖 ----------

// Delete 软删一条帖子：status → deleted，**不物理删除**。
//
// 软删的理由（§3.1）：物理删除会丢历史，而 item_images / contact_views /
// item_returns / match_pairs / reports 五张表都用外键指着 items，
// CASCADE 下去就是一次连带清库。留着行，这些引用全都还有意义。
//
// 同一个 URL 后面是两条路：帖主删自己的帖子只有一次 UPDATE，
// 而 admin 删别人的是一次治理动作（留痕 + 给作者发带理由的通知，和业务同事务）。
// 后者整段走 Moderation.TakedownByAdmin，所以单条删留下的那一行和 #43 批量下架**同一个形状**
// （target_id 和 detail.ids 都写），§13 第 10 步那条自检 SQL 的两个分支才都命中得了它。
func (s *Item) Delete(ctx context.Context, actor *model.User, id int64, adminReason string) error {
	d, err := s.items.GetByID(ctx, id)
	if err != nil {
		return err
	}

	asAdmin, err := authorizeItemWrite(actor, d.UserID, adminReason)
	if err != nil {
		return err
	}
	if d.Status == model.ItemStatusDeleted {
		// 已经删过了。返回 ITEM_CLOSED 而不是当成功：重复删通常是前端连点两次，
		// 让用户看到「这条已经删了」比让他以为又删了一次更清楚。
		return apperr.NewMsg(apperr.CodeItemClosed, "帖子已被删除")
	}

	// 两条路径的共同点是把 status 改成 deleted，区别是**有没有留痕**。
	// 帖主删自己的帖子不需要向任何人交代（那是他在陈述自己的事实），
	// 而 admin 删别人的是一次治理动作：状态改动、admin_actions 那一行、
	// 给作者那条带理由的通知，必须一起提交（§12 判据 ④）。
	//
	// 所以 admin 分支整段交给治理服务（ItemGovernance 那个接缝），而不是在这里
	// 自己 SetStatusTx + Record：那三件事的实现全站只有一份，#43 批量下架和
	// #49 的连带下架用的也是同一份。在这里抄一遍的代价是
	// 「从后台删的帖子作者会收到通知，从帖子页删的不会」—— 这种差别只有用户能发现。
	var notified int
	if asAdmin {
		var err error
		notified, err = s.deleteByAdmin(ctx, actor.ID, id, adminReason)
		if err != nil {
			return err
		}
	} else if err := s.items.SetStatus(ctx, id, model.ItemStatusDeleted); err != nil {
		return err
	}

	attrs := []any{
		slog.Int64("item_id", id),
		slog.Int64("actor_id", actor.ID),
		slog.Bool("as_admin", asAdmin),
	}
	if asAdmin {
		attrs = append(attrs, slog.Int64("owner_id", d.UserID),
			slog.String("reason", adminReason), slog.Int("notified", notified))
		s.logger.WarnContext(ctx, "item.delete_by_admin", attrs...)
	} else {
		s.logger.InfoContext(ctx, "item.delete", attrs...)
	}
	return nil
}

// deleteByAdmin 是 #17 的 admin 分支：开一个事务，把整次下架交给治理服务。
//
// 它做三件事，而且只有第一件是自己的：查理由的长度、开事务、把 tx 交出去。
// 「下架 + 留痕 + 通知」那一套住在 Moderation.TakedownByAdmin 里（理由见上面那段）。
//
// taken 没有回传：能走到这里说明那条帖子确定是 open 或 closed（上面刚判过 deleted），
// 而那批只有一条 id 的 UPDATE 要么改到、要么整笔事务因为别的错误回滚。
// notified 要回传，是为了日志里那句「有没有人被告知」—— 排查「他说他没收到通知」时，
// 这是唯一一条不用查库就能看到的线索。
func (s *Item) deleteByAdmin(ctx context.Context, adminID, id int64, rawReason string) (notified int, err error) {
	reason, err := requireReasonField(adminReasonField, rawReason)
	if err != nil {
		return 0, err
	}

	var taken int
	if err := runInTx(ctx, s.tx, "service.Item", func(tx pgx.Tx) error {
		var err error
		taken, notified, err = s.gov.TakedownByAdmin(ctx, tx, adminID, id, reason)
		return err
	}); err != nil {
		return 0, err
	}
	if taken == 0 {
		// 走到这里只有一个可能：帖主在刚才那次点查之后、这次事务之前自己把帖子删了。
		// 不当失败处理 —— 帖子已经不在广场上了，管理员要的结果已经达成，
		// 而留痕那一行照样写了（#43 对 taken=0 是同一个口径：点了下架这件事本身要可追责）。
		s.logger.WarnContext(ctx, "item.takedown_already_deleted",
			slog.Int64("item_id", id), slog.Int64("admin_id", adminID))
	}
	return notified, nil
}

// ---------- #18 开帖/关帖 ----------

// ChangeStatus 由**发帖人本人**开关自己的帖子。
//
// ⚠ admin 也不行，这是计划 §4 第 18 行「Auth = JWT（本人）」的直接含义，
// 也是 M6 那条 TestAdminBlockedFromOwnerOnlyRoutes 要断言的三个路由之一。
// 关掉一条帖子是「这东西已经还回来了」这个**社区事实**的表态，
// 只有发帖人有资格表态；admin 能销毁内容，但制造不出归属（定位原则 5）。
// admin 想让一条帖子从广场消失，用的是 #43 批量下架（status→deleted），
// 那是一次治理动作，会落 admin_actions、会给作者发通知，和「关帖」是两件事。
func (s *Item) ChangeStatus(ctx context.Context, actor *model.User, id int64, status string) (*StatusResult, error) {
	if status != model.ItemStatusOpen && status != model.ItemStatusClosed {
		return nil, apperr.Validation("status 不对",
			apperr.FieldError{Field: "status", Msg: "只能是 open 或 closed"})
	}

	d, err := s.items.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if actor.ID != d.UserID {
		return nil, apperr.Forbidden("只能操作自己发布的帖子")
	}
	if d.Status == model.ItemStatusDeleted {
		return nil, apperr.NewMsg(apperr.CodeItemClosed, "帖子已被删除，无法修改状态")
	}
	if d.Status == status {
		// 幂等：已经是这个状态了就当成功。前端连点两次不该收到一个 409。
		return &StatusResult{ID: id, Status: status}, nil
	}

	if err := s.items.SetStatus(ctx, id, status); err != nil {
		return nil, err
	}
	s.logger.InfoContext(ctx, "item.status",
		slog.Int64("item_id", id),
		slog.Int64("user_id", actor.ID),
		slog.String("from", d.Status),
		slog.String("to", status))
	return &StatusResult{ID: id, Status: status}, nil
}

// ---------- #14 / #19 列表 ----------

// ListPublic 是 #14 GET /api/items（广场，公开）。
//
// contact 的填充规则：**lost 帖带、found 帖一律 null，不管是谁在查**（计划 §4 第 14 行）。
// 自己的 found 帖在广场上也是锁着的 —— 这样 #14 完全不需要身份，
// 公开、可缓存，也不用为「这一行是不是我的」多发一次查询。
// 想看自己帖子的联系方式去 #19。
func (s *Item) ListPublic(ctx context.Context, q ListQuery) (*Page[model.ItemSummary], error) {
	f, err := parseListQuery(q, publicListStatus)
	if err != nil {
		return nil, err
	}
	rows, total, err := s.items.List(ctx, f)
	if err != nil {
		return nil, err
	}

	list := make([]model.ItemSummary, 0, len(rows))
	for i := range rows {
		var contact *string
		if rows[i].ItemType == model.ItemTypeLost {
			contact = &rows[i].Contact
		}
		list = append(list, rows[i].Summary(contact, s.uploads.URL(rows[i].CoverPath)))
	}
	return &Page[model.ItemSummary]{List: list, Total: total, Page: f.Page, PageSize: f.PageSize}, nil
}

// ListMine 是 #19 GET /api/my/items（我的发布）。
// contact 一律带上 —— 都是自己的帖子，锁着没有任何意义（计划 §4 第 19 行）。
func (s *Item) ListMine(ctx context.Context, userID int64, q ListQuery) (*Page[model.ItemSummary], error) {
	f, err := parseListQuery(q, mineListStatus)
	if err != nil {
		return nil, err
	}
	f.UserID = &userID

	rows, total, err := s.items.List(ctx, f)
	if err != nil {
		return nil, err
	}

	list := make([]model.ItemSummary, 0, len(rows))
	for i := range rows {
		list = append(list, rows[i].Summary(&rows[i].Contact, s.uploads.URL(rows[i].CoverPath)))
	}

	// 被 admin 下架的那几行，在这里向作者解释为什么（见 attachRemovals 的注释：
	// 只有 deleted 的行会被收集，而且整页只查一次）。
	// 这一步放在**返回之前**而不是分页查询之前，所以它不影响 total、不影响翻页。
	if err := s.attachRemovals(ctx, list); err != nil {
		return nil, err
	}
	return &Page[model.ItemSummary]{List: list, Total: total, Page: f.Page, PageSize: f.PageSize}, nil
}

// ---------- #42 帖主自删单张图片 ----------

// DeleteImage 删掉一张图片：数据库一行 + 磁盘一个文件。**不动帖子本身。**
//
// 计划 §4：「#42 和 #45 是一对 —— 帖主自删图（隐私泄露时最快的解法，不用等 admin），
// admin 删图（帖主不配合或已被封号时）。两者都只删 item_images 一行 + 磁盘文件，
// 不动帖子本身 —— 真的捡到东西的人不该因为一张照片有问题就丢掉整条帖子。」
//
// 顺序是「先删库、后删文件」，反过来会留下更糟的状态：
// 文件先没了、库里那行还在 → 前端渲染出一张碎图，而数据库看起来完全正常，
// 没有任何线索指向「磁盘上少了一个文件」。
// 先删库的话，万一文件删不掉，得到的只是一个**谁也看不见的**孤儿文件 ——
// 它不在任何响应里，占点磁盘而已，所以这里只记一条 WARN，不把整个请求报成失败。
func (s *Item) DeleteImage(ctx context.Context, actor *model.User, imageID int64) error {
	im, ownerID, err := s.items.ImageWithOwner(ctx, imageID)
	if err != nil {
		return err
	}
	if actor.ID != ownerID {
		// admin 也不行。#42 的 Auth 列写的是「仅帖主本人」，admin 删图是 #45（M6）。
		// 分成两个端点不是为了麻烦，是因为这两件事的**含义**不同：
		// 帖主删图是「我不想让这张照片挂在这儿」，admin 删图是一次治理动作，
		// 要填理由、要落 admin_actions。合成一个端点就分不出是谁删的了。
		return apperr.Forbidden("只能删除自己帖子上的图片")
	}

	path, err := s.items.DeleteImage(ctx, imageID)
	if err != nil {
		return err
	}
	if err := s.uploads.Remove(path); err != nil {
		s.logger.WarnContext(ctx, "item.image_orphaned",
			slog.Int64("image_id", imageID),
			slog.String("path", path),
			slog.String("err", err.Error()))
	}

	s.logger.InfoContext(ctx, "item.image_deleted",
		slog.Int64("image_id", imageID),
		slog.Int64("item_id", im.ItemID),
		slog.Int64("user_id", actor.ID),
		slog.String("path", path))
	return nil
}

// ---------- 内部辅助 ----------

// checkDictRefs 校验分类和地点这两次引用是否合法。
//
// 两条规则来自计划 §3.2：category_id 必须是**小类**（level 2），
// location_id 必须是**叶子节点**。
//
// 为什么要求小类：分类的半分机制（同大类不同小类给 0.5）只在两级都确定时才算得出来。
// 如果允许选大类，「数码电子」和「手机」之间就没法判断到底是不是同一个小类，
// 匹配算法会退化成一堆 0.5 的噪声。
//
// 为什么叶子的定义是「没有子节点」而不是「level=3」：「其他」是 level=1 且
// is_freeform=true 的一级叶子，它必须能被选中（计划 §3.6 专门为它写了前端红色警告）。
// 按 level 判会把它整个拒掉。
func (s *Item) checkDictRefs(ctx context.Context, categoryID, locationID int64) error {
	c, err := s.dict.GetCategory(ctx, categoryID)
	if err != nil {
		return s.dictRefError(err, "category_id", "分类")
	}
	if !c.IsActive {
		return apperr.Validation("这个分类已经停用了",
			apperr.FieldError{Field: "category_id", Msg: "请重新从分类列表里选一个"})
	}
	if c.Level != 2 {
		return apperr.Validation("分类必须选到小类",
			apperr.FieldError{Field: "category_id", Msg: "「" + c.Name + "」是大类，请再往下选一级"})
	}

	l, err := s.dict.GetLocation(ctx, locationID)
	if err != nil {
		return s.dictRefError(err, "location_id", "地点")
	}
	if !l.IsActive {
		return apperr.Validation("这个地点已经停用了",
			apperr.FieldError{Field: "location_id", Msg: "请重新从地点列表里选一个"})
	}
	children, err := s.dict.CountActiveChildren(ctx, locationID)
	if err != nil {
		return err
	}
	if children > 0 {
		return apperr.Validation("地点必须选到最具体的一级",
			apperr.FieldError{Field: "location_id", Msg: "「" + l.Name + "」下面还有 " +
				"更具体的地点，请再往下选一级（选不到就选「其他」并填最近的建筑）"})
	}
	return nil
}

// dictRefError 把字典查询的错误翻译成字段级 VALIDATION。
//
// NOT_FOUND 要换码：对发帖表单来说「你选的分类不存在」是一个**字段错误**
// （前端要把焦点移回分类选择器），不是「你要访问的资源不存在」。
// 保持 404 的话，前端那个统一的「404 就跳首页/提示资源不存在」的拦截器
// 会把用户从填了一半的表单里踢出去。
func (s *Item) dictRefError(err error, field, what string) error {
	if apperr.IsCode(err, apperr.CodeNotFound) {
		return apperr.Validation(what+"不存在",
			apperr.FieldError{Field: field, Msg: "请重新从" + what + "列表里选一个"})
	}
	return err
}

// buildView 把 repo 的一行组装成 #15 的响应形状。
//
// forceContact=true 用于「操作者刚刚把 contact 提交上来」的两个场合
// （#13 发帖、#16 改帖）：那时候再按可见性规则给他一个 null 是荒谬的。
func (s *Item) buildView(ctx context.Context, d *model.ItemDetail, viewer *model.User, forceContact bool) (*model.ItemView, error) {
	imgs, err := s.items.ListImages(ctx, d.ID)
	if err != nil {
		return nil, err
	}

	views := make([]model.ImageView, 0, len(imgs))
	for _, im := range imgs {
		views = append(views, model.ImageView{
			ID:        im.ID,
			URL:       s.uploads.URL(im.Path),
			SortOrder: im.SortOrder,
		})
	}

	locked := s.contactLockedAfterLookup(ctx, d, viewer, forceContact)
	var contact *string
	if !locked {
		contact = &d.Contact
	}

	v := d.View(contact, locked, views)
	return &v, nil
}

// contactLockedAfterLookup 是计划 §4「#15 的 contact 可见性规则」的完整落地。
//
// 前半段是纯函数 contactLocked（只看类型和身份），后半段是那次查库。
// 分成两段的理由写在 contactLocked 的注释里：那两条纯规则能被表驱动单测扫尽，
// 而「查库」这一步只能拿 fake store 测，两段的测法本来就不该混在一起。
//
// 三条不打扰的规则按代价从低到高排：
//   - lost 帖 / 作者本人 → 纯函数就返回 false，**一次查询都不发**
//   - 匿名的 found 请求 → 直接锁，也不发查询（没有 id 可查，发了是白费）
//     这是 #15 作为公开接口的常态路径，省掉这一次往返是有意义的
//   - 已登录的非作者 → 才走 idx_contact_views_user 那一次点查
//
// ⚠ 查询失败一律**按锁着处理**，并且不把错误往上抛：
//   - 往上抛意味着 #15 这个「未登录也能逛」的公开接口在 contact_views 出问题时
//     整条帖子读不出来 —— 用户看到的是广场点进详情就 500。
//   - 反过来，「查询失败但放行」是把别人的手机号发出去。
//     两个后果不对称：前者是体验受损，后者是隐私事故，所以这里 fail closed。
//     失败本身进日志，不静默。
func (s *Item) contactLockedAfterLookup(ctx context.Context, d *model.ItemDetail, viewer *model.User, forceContact bool) bool {
	if forceContact || !contactLocked(&d.Item, viewer) {
		return false
	}
	if viewer == nil {
		return true
	}

	viewed, err := s.contacts.Viewed(ctx, d.ID, viewer.ID)
	if err != nil {
		s.logger.WarnContext(ctx, "contact.viewed_lookup_failed",
			slog.Any("err", err),
			slog.Int64("item_id", d.ID),
			slog.Int64("user_id", viewer.ID),
			slog.String("action", "按锁着处理（fail closed）"),
		)
		return true
	}
	return !viewed
}

// canSeeDeleted 报告 viewer 能不能看一条已软删的帖子。
//
// 只有作者本人和 admin。作者要能看见自己帖子被下架了（否则他会以为帖子凭空消失），
// admin 要能核对治理结果。其他任何人一律看不到 —— 软删对外就是不存在。
func canSeeDeleted(viewer *model.User, ownerID int64) bool {
	if viewer == nil {
		return false
	}
	return viewer.ID == ownerID || viewer.IsAdmin()
}

// ---------- 「为什么不见了」：读时派生 ----------

// removalFor 查一条帖子最近一次被下架的留痕。查不到就返回 nil，
// 而 nil 在响应里的表现是**没有 removal 这个键**（model 那边带 omitempty）。
//
// ⚠ 「查不到」有两种完全不同的原因，而这里一律当成同一件事处理：
//   - 这条帖子的 deleted 不是 admin 造成的（帖主自己 #18 删的）—— 那确实没有说法要给；
//   - 登记簿查询本身坏了 —— 那会被下面的 error 分支带到 handler 变成 INTERNAL。
//
// 分清这两件事靠的是「err 是不是 nil」，不是靠 map 里有没有这个 key：LatestTakedowns
// 查询失败时返回的是 (nil, err)，不是 (空 map, nil)。所以「查不到」和「没查成功」
// 在类型层面就不会混 —— 这是这个方法可以只写三行的原因。
func (s *Item) removalFor(ctx context.Context, id int64) (*model.RemovalView, error) {
	if s.takedowns == nil {
		return nil, nil
	}
	m, err := s.takedowns.LatestTakedowns(ctx, []int64{id})
	if err != nil {
		return nil, err
	}
	return removalOf(m, id), nil
}

// removalOf 从一批结果里取这一条帖子那一份，没有就返回 nil。
func removalOf(m map[int64]repo.TakedownInfo, id int64) *model.RemovalView {
	t, ok := m[id]
	if !ok {
		return nil
	}
	return model.NewRemovalView(t.ActionID, t.Reason, t.CreatedAt)
}

// attachRemovals 给一页「我的发布」里 deleted 的那几行挂上下架理由。
//
// 两个刻意的设计：
//
//  1. **只收集 deleted 的 id**。open/closed 的行不查、也不该查 —— 它们没被下架过，
//     而每一次多余收集都是一次没有意义的登记簿扫描。
//     这一条是能被测的（第①层那个 fake 记下自己收到了哪些 id），所以它不是注释里的
//     愿望，是判据。
//  2. **整页只查一次**，不是每行查一次。一页 20 行里有 15 行是 deleted 的话，
//     逐行查就是 15 次登记簿扫描，而这一层脚本里传的是**一批 id**，一次就够。
//     （批量下架本来就是这功能最主要的使用场景 —— 一次 spam 处置就是几十条。）
//
// 传进来的是一页的**切片**而不是 Page 结构体：它只改元素，不改长度、不改 total，
// 所以签名里没有任何翻页信息，也就没有「改错了页码」这种错误可犯。
func (s *Item) attachRemovals(ctx context.Context, list []model.ItemSummary) error {
	if s.takedowns == nil || len(list) == 0 {
		return nil
	}

	ids := make([]int64, 0, len(list))
	for i := range list {
		if list[i].Status == model.ItemStatusDeleted {
			ids = append(ids, list[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}

	m, err := s.takedowns.LatestTakedowns(ctx, ids)
	if err != nil {
		return err
	}
	for i := range list {
		if r := removalOf(m, list[i].ID); r != nil {
			list[i].Removal = r
		}
	}
	return nil
}
