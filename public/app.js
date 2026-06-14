const state = {
  options: null,
  user: null,
  selectedYear: 2030,
  mixDimension: "country",
  breakdownDimension: "country",
  entityType: "country",
  entityName: "United States",
  bridgeCountry: "",
  bridgeCompany: "",
  financeCompany: "Amazon",
  hardwareTrack: "optical_interconnect",
  capexSplitView: "all_components",
  hardwareDashboard: null,
  hardwareMarket: null,
  updateStatus: null,
  managedUsers: [],
  managedUserTiers: ["basic", "pro", "enterprise", "admin"],
  editingUserId: null,
  plans: [],
  authMode: "login",
  controlsWired: false,
  shellWired: false,
  updatePollTimer: null,
  language: localStorage.getItem("aicapex_language") || "zh",
};

const colors = ["#2563eb", "#0f766e", "#b45309", "#7c3aed", "#dc2626", "#0891b2"];
const updatePollIntervalMs = 24 * 60 * 60 * 1000;
const supportedLanguages = new Set(["zh", "en", "es"]);
const localeByLanguage = { zh: "zh-CN", en: "en-US", es: "es-ES" };

const translations = {
  en: {
    appTitle: "CapEx Monitor",
    loginSubtitle: "Sign in to view your subscription workspace.",
    email: "Email",
    username: "Username",
    password: "Password",
    login: "Login",
    register: "Register",
    signIn: "Sign in",
    createAccount: "Create account",
    continueAsGuest: "Continue as guest",
    loadingRun: "Loading model run",
    logout: "Log out",
    signInRegister: "Sign in / Register",
    navOverview: "Overview",
    navBreakdowns: "Breakdowns",
    navBridge: "Country x Company",
    navFinance: "Funding & ROIC",
    navHardware: "Hardware Breadth",
    navAudit: "Audit",
    navUpdates: "Updates",
    navUsers: "Users",
    navPlans: "Plans",
    navSources: "Sources",
    overviewEyebrow: "2026-2045 forecast",
    overviewTitle: "Global AI Infrastructure Investment",
    connecting: "Connecting",
    globalTotal: "Global Total",
    usdNominal: "USD bn, nominal",
    mix2030: "2030 Mix",
    topCategories: "Top categories",
    countries: "Countries",
    companies: "Companies",
    components: "Components",
    country: "Country",
    company: "Company",
    component: "Component",
    drilldown: "Drilldown",
    entityComponentMix: "Entity Component Mix",
    componentAllocation: "Component Allocation",
    amountByComponent: "Amount by component",
    topForecastRows: "Top Forecast Rows",
    countryRanking: "Country ranking",
    item: "Item",
    share: "Share",
    usdBn: "USD bn",
    attributionBridge: "Attribution bridge",
    bridgeTitle: "Country x Company x Component",
    largestAllocations: "Largest Allocations",
    filteredByYear: "Filtered by selected year",
    capitalStack: "Capital stack",
    fundingRoicProxy: "Funding & ROIC Proxy",
    fundingMix: "Funding Mix",
    selectedYear: "Selected year",
    roicPath: "ROIC Path",
    incrementalProjectView: "Incremental project view",
    hardwareEyebrow: "Listed-company baskets",
    hardwareTitle: "AI Hardware Market Breadth",
    marketBreadth: "Market Breadth",
    breadthHistory: "Breadth History",
    latestTradingDays: "Latest trading days",
    totalBreadth: "Total Breadth",
    date: "Date",
    above20Day: "Above 20-day SMA",
    above50Day: "Above 50-day SMA",
    twentyDayReturn: "20-day return",
    hardwareIndex: "Track Index",
    equalWeightProxy: "Weighted constituent proxy",
    constituents: "Constituents",
    ticker: "Ticker",
    price: "Price",
    sma20: "20D SMA",
    sma50: "50D SMA",
    capexTrackExposure: "CapEx Track Exposure",
    modelCapexSplit: "Model CapEx Split",
    capexSplitDetail: "CapEx Split Detail",
    selectedSplit: "Selected split",
    splitShare: "Split share",
    basis: "Basis",
    allComponents: "All components",
    modelDerived: "Model-derived",
    opticalInvestmentSplit: "Optical Investment Split",
    opticalSourceBasis: "Optical source basis",
    category: "Category",
    opticalShare: "Optical share",
    track: "Track",
    score: "Score",
    priced: "Priced",
    asOf: "As of",
    auditEyebrow: "Model audit",
    modelAudit: "External Data & Adjustment Audit",
    artifactPaths: "Artifact Paths",
    latestRun: "Latest run",
    externalSourceStatus: "External Source Status",
    latestObservations: "Latest observations",
    driverAdjustments: "Driver Adjustments",
    modelSignalLog: "Model signal log",
    source: "Source",
    status: "Status",
    latestDate: "Latest date",
    latestValue: "Latest value",
    yoy: "YoY",
    rows: "Rows",
    driver: "Driver",
    year: "Year",
    baseline: "Baseline",
    adjusted: "Adjusted",
    delta: "Delta",
    signal: "Signal",
    rationale: "Rationale",
    automation: "Automation",
    dataUpdateMode: "Data Update Mode",
    loading: "Loading",
    mode: "Mode",
    intervalHours: "Interval hours",
    schedule: "Schedule",
    interval: "Interval",
    weekly: "Weekly",
    weeklyDay: "Weekly day",
    sunday: "Sunday",
    monday: "Monday",
    tuesday: "Tuesday",
    wednesday: "Wednesday",
    thursday: "Thursday",
    friday: "Friday",
    saturday: "Saturday",
    weeklyTime: "Weekly time",
    autoSchedule: "Auto schedule",
    token: "Token",
    save: "Save",
    runNow: "Run now",
    refresh: "Refresh",
    nextRun: "Next run",
    lastFinish: "Last finish",
    exit: "Exit",
    latestArchive: "Latest archive",
    administration: "Administration",
    userManagement: "User Management",
    createUser: "Create User",
    editUser: "Edit User",
    newAccount: "New account",
    editingAccount: "Editing account",
    displayName: "Display name",
    tier: "Tier",
    active: "Active",
    inactive: "Inactive",
    existingUsers: "Existing Users",
    appUsersTable: "aicapex_auth.siteusers",
    lastLogin: "Last login",
    action: "Action",
    edit: "Edit",
    newUser: "New user",
    userSaved: "User saved",
    passwordRequired: "Password is required for new users.",
    passwordOptionalOnEdit: "Leave password blank to keep the current password.",
    subscription: "Subscription",
    plansTitle: "Plans",
    currentPlan: "Current plan",
    upgrade: "Upgrade",
    useFreePlan: "Use free plan",
    subscribe: "Subscribe",
    monthlySubscription: "Monthly subscription",
    oneTimePayment: "One-time pay",
    oneTimeAccess: "{days}-day access",
    demoUpgradeApplied: "Stripe is not configured. Demo upgrade has been applied locally.",
    paymentNotConfigured: "Payment is not configured. Please contact the administrator.",
    paymentProviderStripe: "Stripe Checkout",
    paymentProviderStripeOneTime: "Stripe one-time Checkout",
    paymentUnavailable: "Payment not configured",
    paymentPending: "Redirecting to secure checkout.",
    manageBilling: "Manage billing",
    billingProfileMissing: "No Stripe billing profile is linked to this account.",
    registerBeforeSubscribe: "Please register or sign in before subscribing.",
    guestUser: "Guest",
    traceability: "Traceability",
    sourceRegister: "Source Register",
    id: "ID",
    theme: "Theme",
    keyFact: "Key fact",
    type: "Type",
    all: "All",
    noData: "No data",
    connected: "Connected",
    degraded: "Degraded",
    error: "Error",
    startingModelYear: "Starting model year",
    yearInvestment: "{year} investment",
    cumulativeInvestment: "2026-2045 cumulative",
    yoyNote: "{value} YoY",
    sourceRecords: "{count} source records",
    componentAllocationFor: "{name} Component Allocation",
    rankingFor: "{dimension} ranking for {year}",
    allocationRows: "{year} allocation rows",
    companyYear: "{company}, {year}",
    running: "Running",
    scheduled: "Scheduled",
    manual: "Manual",
    disabled: "Disabled",
    loginRequired: "Please sign in to continue.",
    invalidLogin: "Invalid email or password.",
    accessDenied: "Your subscription tier cannot view this content.",
    sessionExpired: "Your session expired. Please sign in again.",
    noArtifact: "No artifact archive for this run",
    runId: "Run ID",
    pipelineId: "Pipeline ID",
    generatedWorkbook: "Generated workbook",
    sourceWorkbook: "Source workbook",
    sourceSnapshot: "Source snapshot",
    adjustmentFile: "Adjustment file",
    manifestFile: "Manifest file",
    generatedAt: "Generated at",
    importTrigger: "Import trigger",
    tier_free: "Free",
    tier_basic: "Basic",
    tier_pro: "Pro",
    tier_enterprise: "Enterprise",
    tier_admin: "Admin",
    mode_workbook: "Workbook import",
    mode_pipeline: "External data pipeline",
  },
  zh: {
    appTitle: "资本开支监控",
    loginSubtitle: "登录后查看你的订阅工作台。",
    email: "邮箱",
    username: "用户名",
    password: "密码",
    login: "登录",
    register: "注册",
    signIn: "登录",
    createAccount: "创建账户",
    continueAsGuest: "游客继续",
    loadingRun: "正在加载模型版本",
    logout: "退出",
    signInRegister: "登录 / 注册",
    navOverview: "总览",
    navBreakdowns: "拆分",
    navBridge: "国家 x 公司",
    navFinance: "融资与 ROIC",
    navHardware: "硬件宽度",
    navAudit: "审计",
    navUpdates: "更新",
    navUsers: "用户",
    navPlans: "套餐",
    navSources: "来源",
    overviewEyebrow: "2026-2045 预测",
    overviewTitle: "全球 AI 基础设施投资",
    connecting: "连接中",
    globalTotal: "全球总量",
    usdNominal: "十亿美元，名义值",
    mix2030: "2030 结构",
    topCategories: "主要类别",
    countries: "国家",
    companies: "公司",
    components: "组件",
    country: "国家",
    company: "公司",
    component: "组件",
    drilldown: "明细",
    entityComponentMix: "实体组件结构",
    componentAllocation: "组件分配",
    amountByComponent: "按组件金额",
    topForecastRows: "主要预测行",
    countryRanking: "国家排名",
    item: "项目",
    share: "占比",
    usdBn: "十亿美元",
    attributionBridge: "归因桥",
    bridgeTitle: "国家 x 公司 x 组件",
    largestAllocations: "最大分配项",
    filteredByYear: "按所选年份筛选",
    capitalStack: "资本结构",
    fundingRoicProxy: "融资与 ROIC 代理指标",
    fundingMix: "融资结构",
    selectedYear: "所选年份",
    roicPath: "ROIC 路径",
    incrementalProjectView: "增量项目视角",
    hardwareEyebrow: "上市公司篮子",
    hardwareTitle: "AI 硬件市场宽度",
    marketBreadth: "市场宽度",
    breadthHistory: "宽度历史",
    latestTradingDays: "最近交易日",
    totalBreadth: "总宽度",
    date: "日期",
    above20Day: "高于 20 日均线",
    above50Day: "高于 50 日均线",
    twentyDayReturn: "20 日收益",
    hardwareIndex: "赛道指数",
    equalWeightProxy: "成分股加权代理",
    constituents: "成分股",
    ticker: "代码",
    price: "价格",
    sma20: "20 日均线",
    sma50: "50 日均线",
    capexTrackExposure: "CapEx 赛道暴露",
    modelCapexSplit: "模型 CapEx 拆分",
    capexSplitDetail: "CapEx 拆分明细",
    selectedSplit: "所选拆分",
    splitShare: "拆分占比",
    basis: "口径",
    allComponents: "全部组件",
    modelDerived: "模型派生",
    opticalInvestmentSplit: "光相关投资拆分",
    opticalSourceBasis: "光投资来源口径",
    category: "类别",
    opticalShare: "光相关占比",
    track: "赛道",
    score: "得分",
    priced: "有行情",
    asOf: "截至",
    auditEyebrow: "模型审计",
    modelAudit: "外部数据与模型调整审计",
    artifactPaths: "存档路径",
    latestRun: "最新版本",
    externalSourceStatus: "外部数据状态",
    latestObservations: "最新观测",
    driverAdjustments: "驱动项调整",
    modelSignalLog: "模型信号日志",
    source: "来源",
    status: "状态",
    latestDate: "最新日期",
    latestValue: "最新值",
    yoy: "同比",
    rows: "行数",
    driver: "驱动项",
    year: "年份",
    baseline: "基准",
    adjusted: "调整后",
    delta: "变化",
    signal: "信号",
    rationale: "依据",
    automation: "自动化",
    dataUpdateMode: "数据更新模式",
    loading: "加载中",
    mode: "模式",
    intervalHours: "间隔小时",
    schedule: "计划",
    interval: "按间隔",
    weekly: "每周",
    weeklyDay: "每周日期",
    sunday: "周日",
    monday: "周一",
    tuesday: "周二",
    wednesday: "周三",
    thursday: "周四",
    friday: "周五",
    saturday: "周六",
    weeklyTime: "每周时间",
    autoSchedule: "自动计划",
    token: "令牌",
    save: "保存",
    runNow: "立即运行",
    refresh: "刷新",
    nextRun: "下次运行",
    lastFinish: "上次完成",
    exit: "退出码",
    latestArchive: "最新存档",
    administration: "管理",
    userManagement: "用户管理",
    createUser: "创建用户",
    editUser: "编辑用户",
    newAccount: "新账户",
    editingAccount: "正在编辑",
    displayName: "显示名称",
    tier: "等级",
    active: "启用",
    inactive: "停用",
    existingUsers: "现有用户",
    appUsersTable: "aicapex_auth.siteusers",
    lastLogin: "上次登录",
    action: "操作",
    edit: "编辑",
    newUser: "新用户",
    userSaved: "用户已保存",
    passwordRequired: "新用户必须填写密码。",
    passwordOptionalOnEdit: "编辑时留空密码则保留原密码。",
    subscription: "订阅",
    plansTitle: "套餐",
    currentPlan: "当前套餐",
    upgrade: "升级",
    useFreePlan: "使用免费套餐",
    subscribe: "订阅",
    monthlySubscription: "月付订阅",
    oneTimePayment: "微信/支付宝一次性支付",
    oneTimeAccess: "{days} 天访问权",
    demoUpgradeApplied: "Stripe 未配置，已按本地演示通道开通该套餐。",
    paymentNotConfigured: "付款系统未配置，请联系管理员。",
    paymentProviderStripe: "Stripe Checkout",
    paymentProviderStripeOneTime: "Stripe 一次性付款",
    paymentUnavailable: "付款未配置",
    paymentPending: "正在跳转到安全付款页面。",
    manageBilling: "管理账单",
    billingProfileMissing: "当前账户还没有关联 Stripe 账单资料。",
    registerBeforeSubscribe: "请先注册或登录，再订阅套餐。",
    guestUser: "游客",
    traceability: "可追溯",
    sourceRegister: "来源登记",
    id: "ID",
    theme: "主题",
    keyFact: "关键事实",
    type: "类型",
    all: "全部",
    noData: "暂无数据",
    connected: "已连接",
    degraded: "异常",
    error: "错误",
    startingModelYear: "模型起始年份",
    yearInvestment: "{year} 投资",
    cumulativeInvestment: "2026-2045 累计",
    yoyNote: "同比 {value}",
    sourceRecords: "{count} 条来源记录",
    componentAllocationFor: "{name} 组件分配",
    rankingFor: "{year} 年{dimension}排名",
    allocationRows: "{year} 年分配行",
    companyYear: "{company}，{year}",
    running: "运行中",
    scheduled: "已排程",
    manual: "手动",
    disabled: "已禁用",
    loginRequired: "请先登录。",
    invalidLogin: "邮箱或密码不正确。",
    accessDenied: "当前订阅等级无法查看该内容。",
    sessionExpired: "登录已过期，请重新登录。",
    noArtifact: "该版本没有存档记录",
    runId: "版本 ID",
    pipelineId: "流水线 ID",
    generatedWorkbook: "生成的 Excel",
    sourceWorkbook: "源 Excel",
    sourceSnapshot: "来源快照",
    adjustmentFile: "调整文件",
    manifestFile: "清单文件",
    generatedAt: "生成时间",
    importTrigger: "导入触发",
    tier_free: "免费",
    tier_basic: "基础版",
    tier_pro: "专业版",
    tier_enterprise: "企业版",
    tier_admin: "管理员",
    mode_workbook: "Excel 导入",
    mode_pipeline: "外部数据流水线",
  },
  es: {
    appTitle: "Monitor de CapEx",
    loginSubtitle: "Inicia sesión para ver tu espacio de suscripción.",
    email: "Correo",
    username: "Usuario",
    password: "Contraseña",
    login: "Entrar",
    register: "Registrarse",
    signIn: "Iniciar sesión",
    createAccount: "Crear cuenta",
    continueAsGuest: "Continuar como invitado",
    loadingRun: "Cargando versión del modelo",
    logout: "Salir",
    signInRegister: "Entrar / Registrarse",
    navOverview: "Resumen",
    navBreakdowns: "Desgloses",
    navBridge: "País x Empresa",
    navFinance: "Financiación y ROIC",
    navAudit: "Auditoría",
    navUpdates: "Actualizaciones",
    navUsers: "Usuarios",
    navPlans: "Planes",
    navSources: "Fuentes",
    overviewEyebrow: "Pronóstico 2026-2045",
    overviewTitle: "Inversión global en infraestructura de IA",
    connecting: "Conectando",
    globalTotal: "Total global",
    usdNominal: "Miles de millones USD, nominal",
    mix2030: "Mezcla 2030",
    topCategories: "Categorías principales",
    countries: "Países",
    companies: "Empresas",
    components: "Componentes",
    country: "País",
    company: "Empresa",
    component: "Componente",
    drilldown: "Detalle",
    entityComponentMix: "Mezcla de componentes",
    componentAllocation: "Asignación de componentes",
    amountByComponent: "Importe por componente",
    topForecastRows: "Filas principales",
    countryRanking: "Ranking por país",
    item: "Elemento",
    share: "Participación",
    usdBn: "Miles de millones USD",
    attributionBridge: "Puente de atribución",
    bridgeTitle: "País x Empresa x Componente",
    largestAllocations: "Mayores asignaciones",
    filteredByYear: "Filtrado por año seleccionado",
    capitalStack: "Estructura de capital",
    fundingRoicProxy: "Financiación y ROIC proxy",
    fundingMix: "Mezcla de financiación",
    selectedYear: "Año seleccionado",
    roicPath: "Trayectoria ROIC",
    incrementalProjectView: "Vista incremental del proyecto",
    navHardware: "Amplitud de hardware",
    hardwareEyebrow: "Cestas de empresas cotizadas",
    hardwareTitle: "Amplitud del mercado de hardware de IA",
    marketBreadth: "Amplitud de mercado",
    breadthHistory: "Historial de amplitud",
    latestTradingDays: "Últimos días de negociación",
    totalBreadth: "Amplitud total",
    date: "Fecha",
    above20Day: "Sobre media de 20 días",
    above50Day: "Sobre media de 50 días",
    twentyDayReturn: "Retorno de 20 días",
    hardwareIndex: "Índice de segmento",
    equalWeightProxy: "Proxy ponderado por componentes",
    constituents: "Componentes",
    ticker: "Ticker",
    price: "Precio",
    sma20: "Media 20D",
    sma50: "Media 50D",
    modelCapexSplit: "Desglose de CapEx del modelo",
    capexSplitDetail: "Detalle del desglose de CapEx",
    selectedSplit: "Desglose seleccionado",
    splitShare: "Participación del desglose",
    basis: "Base",
    modelDerived: "Derivado del modelo",
    score: "Puntuación",
    asOf: "A fecha de",
    auditEyebrow: "Auditoría del modelo",
    modelAudit: "Auditoría de datos externos y ajustes",
    artifactPaths: "Rutas de artefactos",
    latestRun: "Última versión",
    externalSourceStatus: "Estado de fuentes externas",
    latestObservations: "Últimas observaciones",
    driverAdjustments: "Ajustes de drivers",
    modelSignalLog: "Registro de señales",
    source: "Fuente",
    status: "Estado",
    latestDate: "Fecha más reciente",
    latestValue: "Valor más reciente",
    yoy: "Interanual",
    rows: "Filas",
    driver: "Driver",
    year: "Año",
    baseline: "Base",
    adjusted: "Ajustado",
    delta: "Delta",
    signal: "Señal",
    rationale: "Justificación",
    automation: "Automatización",
    dataUpdateMode: "Modo de actualización",
    loading: "Cargando",
    mode: "Modo",
    intervalHours: "Horas de intervalo",
    schedule: "Programa",
    interval: "Intervalo",
    weekly: "Semanal",
    weeklyDay: "Día semanal",
    sunday: "Domingo",
    monday: "Lunes",
    tuesday: "Martes",
    wednesday: "Miércoles",
    thursday: "Jueves",
    friday: "Viernes",
    saturday: "Sábado",
    weeklyTime: "Hora semanal",
    autoSchedule: "Programación automática",
    token: "Token",
    save: "Guardar",
    runNow: "Ejecutar ahora",
    refresh: "Actualizar",
    nextRun: "Próxima ejecución",
    lastFinish: "Última finalización",
    exit: "Salida",
    latestArchive: "Último archivo",
    administration: "Administración",
    userManagement: "Gestión de usuarios",
    createUser: "Crear usuario",
    editUser: "Editar usuario",
    newAccount: "Cuenta nueva",
    editingAccount: "Editando cuenta",
    displayName: "Nombre visible",
    tier: "Nivel",
    active: "Activo",
    inactive: "Inactivo",
    existingUsers: "Usuarios existentes",
    appUsersTable: "aicapex_auth.siteusers",
    lastLogin: "Último acceso",
    action: "Acción",
    edit: "Editar",
    newUser: "Nuevo usuario",
    userSaved: "Usuario guardado",
    passwordRequired: "La contraseña es obligatoria para usuarios nuevos.",
    passwordOptionalOnEdit: "Deja la contraseña en blanco para conservarla.",
    subscription: "Suscripción",
    plansTitle: "Planes",
    currentPlan: "Plan actual",
    upgrade: "Mejorar",
    useFreePlan: "Usar plan gratis",
    subscribe: "Suscribirse",
    monthlySubscription: "Suscripción mensual",
    oneTimePayment: "Pago único",
    oneTimeAccess: "Acceso de {days} días",
    demoUpgradeApplied: "Stripe no está configurado. Se aplicó una mejora demo local.",
    paymentNotConfigured: "El pago no está configurado. Contacta al administrador.",
    paymentProviderStripe: "Stripe Checkout",
    paymentProviderStripeOneTime: "Checkout único de Stripe",
    paymentUnavailable: "Pago no configurado",
    paymentPending: "Redirigiendo al checkout seguro.",
    manageBilling: "Gestionar facturación",
    billingProfileMissing: "No hay un perfil de facturación de Stripe vinculado a esta cuenta.",
    registerBeforeSubscribe: "Regístrate o inicia sesión antes de suscribirte.",
    guestUser: "Invitado",
    traceability: "Trazabilidad",
    sourceRegister: "Registro de fuentes",
    id: "ID",
    theme: "Tema",
    keyFact: "Dato clave",
    type: "Tipo",
    all: "Todo",
    noData: "Sin datos",
    connected: "Conectado",
    degraded: "Degradado",
    error: "Error",
    startingModelYear: "Año inicial del modelo",
    yearInvestment: "Inversión {year}",
    cumulativeInvestment: "Acumulado 2026-2045",
    yoyNote: "{value} interanual",
    sourceRecords: "{count} registros de fuente",
    componentAllocationFor: "Asignación de componentes de {name}",
    rankingFor: "Ranking de {dimension} para {year}",
    allocationRows: "Filas de asignación {year}",
    companyYear: "{company}, {year}",
    running: "Ejecutando",
    scheduled: "Programado",
    manual: "Manual",
    disabled: "Desactivado",
    loginRequired: "Inicia sesión para continuar.",
    invalidLogin: "Correo o contraseña no válidos.",
    accessDenied: "Tu nivel de suscripción no puede ver este contenido.",
    sessionExpired: "Tu sesión expiró. Inicia sesión de nuevo.",
    noArtifact: "No hay archivo para esta versión",
    runId: "ID de versión",
    pipelineId: "ID de pipeline",
    generatedWorkbook: "Excel generado",
    sourceWorkbook: "Excel fuente",
    sourceSnapshot: "Snapshot de fuentes",
    adjustmentFile: "Archivo de ajustes",
    manifestFile: "Archivo manifest",
    generatedAt: "Generado",
    importTrigger: "Activador",
    tier_free: "Gratis",
    tier_basic: "Básico",
    tier_pro: "Pro",
    tier_enterprise: "Empresa",
    tier_admin: "Administrador",
    mode_workbook: "Importación de Excel",
    mode_pipeline: "Pipeline de datos externos",
  },
};

function $(id) {
  return document.getElementById(id);
}

function t(key, vars = {}) {
  const dictionary = translations[state.language] || translations.en;
  const template = dictionary[key] || translations.en[key] || key;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
}

function normalizeLanguage(language) {
  return supportedLanguages.has(language) ? language : "zh";
}

function syncLanguageControls() {
  for (const id of ["languageSelect", "loginLanguageSelect"]) {
    const select = $(id);
    if (select) select.value = state.language;
  }
}

function applyI18n() {
  state.language = normalizeLanguage(state.language);
  document.documentElement.lang = localeByLanguage[state.language] || "zh-CN";
  document.title = t("appTitle");
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
  syncLanguageControls();
  populateManagedUserTierOptions();
  renderAccount();
  if ($("authTabs")) setAuthMode(state.authMode);
}

async function setLanguage(language, { reload = true } = {}) {
  state.language = normalizeLanguage(language);
  localStorage.setItem("aicapex_language", state.language);
  applyI18n();
  if (state.options) populateOptionControls();
  if (state.managedUsers?.length) renderManagedUsers(state.managedUsers);
  if (reload && state.user && !$("appShell").classList.contains("hidden")) {
    await loadAvailableData().catch((error) => console.error(error));
  }
}

async function api(path, options = {}) {
  const fetchOptions = {
    credentials: "same-origin",
    ...options,
  };
  if (fetchOptions.body && !(fetchOptions.body instanceof FormData)) {
    fetchOptions.headers = {
      "Content-Type": "application/json",
      ...(fetchOptions.headers || {}),
    };
  }

  const response = await fetch(path, fetchOptions);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.code = body.error_code;
    error.requiredTier = body.required_tier;
    if (response.status === 401 && !path.startsWith("/api/auth/")) handleSessionExpired();
    throw error;
  }
  return body;
}

function can(feature) {
  return Boolean(state.user?.capabilities?.[feature]);
}

function fmtUsd(value) {
  const number = Number(value || 0);
  if (Math.abs(number) >= 1000) return `$${(number / 1000).toFixed(2)}T`;
  return `$${number.toFixed(1)}B`;
}

function fmtPrice(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `$${Number(value).toFixed(2)}`;
}

function fmtCny(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  return `¥${Number(value).toLocaleString("zh-CN", { maximumFractionDigits: 0 })}`;
}

function fmtPct(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setSelectOptions(select, values, selected, includeAll = false) {
  if (!select) return;
  const normalizedSelected = String(selected ?? "");
  const options = includeAll ? [{ label: t("all"), value: "" }] : [];
  for (const value of values || []) options.push({ label: String(value), value: String(value) });
  select.innerHTML = options
    .map(
      (option) =>
        `<option value="${esc(option.value)}"${option.value === normalizedSelected ? " selected" : ""}>${esc(option.label)}</option>`,
    )
    .join("");
}

function renderAccount() {
  if (!state.user || !$("accountName")) return;
  $("accountName").textContent = state.user.is_guest ? t("guestUser") : state.user.display_name || state.user.email;
  $("accountTier").textContent = t(`tier_${state.user.tier}`);
  $("logoutButton").textContent = state.user.is_guest ? t("signInRegister") : t("logout");
}

function applyPermissions() {
  document.querySelectorAll("[data-feature]").forEach((element) => {
    const feature = element.dataset.feature;
    element.classList.toggle("hidden", !can(feature));
  });

  const activeNav = document.querySelector(".nav-list a.active");
  if (activeNav?.classList.contains("hidden")) {
    const firstVisible = document.querySelector(".nav-list a:not(.hidden)");
    document.querySelectorAll(".nav-list a").forEach((link) => link.classList.toggle("active", link === firstVisible));
  }
}

function showLogin(message = "") {
  stopUpdatePolling();
  state.user = null;
  state.options = null;
  $("appShell").classList.add("hidden");
  $("loginView").classList.remove("hidden");
  $("loginError").textContent = message;
  $("loginPassword").value = "";
  applyI18n();
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("appShell").classList.remove("hidden");
  $("loginError").textContent = "";
  applyI18n();
  applyPermissions();
}

function handleSessionExpired() {
  if (state.user && !state.user.is_guest) showLogin(t("sessionExpired"));
}

function setAuthMode(mode) {
  state.authMode = mode === "register" ? "register" : "login";
  document.querySelectorAll("#authTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === state.authMode);
  });
  $("registerNameLabel").classList.toggle("hidden", state.authMode !== "register");
  document.querySelector("#loginForm button[type='submit']").textContent =
    state.authMode === "register" ? t("createAccount") : t("signIn");
  $("loginPassword").autocomplete = state.authMode === "register" ? "new-password" : "current-password";
  $("loginError").textContent = "";
}

function renderKpis(summary) {
  const byYear = new Map(summary.key_years.map((row) => [row.year_num, row]));
  const cards = [
    [t("yearInvestment", { year: 2026 }), fmtUsd(byYear.get(2026)?.total_usd_bn), t("startingModelYear")],
    [
      t("yearInvestment", { year: 2030 }),
      fmtUsd(byYear.get(2030)?.total_usd_bn),
      t("yoyNote", { value: fmtPct(byYear.get(2030)?.yoy_growth) }),
    ],
    [
      t("yearInvestment", { year: 2045 }),
      fmtUsd(byYear.get(2045)?.total_usd_bn),
      t("yoyNote", { value: fmtPct(byYear.get(2045)?.yoy_growth) }),
    ],
    [t("cumulativeInvestment"), fmtUsd(summary.cumulative_usd_bn), t("sourceRecords", { count: summary.source_count })],
  ];
  $("kpiGrid").innerHTML = cards
    .map(
      ([label, value, note]) => `
        <div class="kpi">
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
          <small>${esc(note)}</small>
        </div>`,
    )
    .join("");
}

function renderLineChart(containerId, rows, valueKey, { yFormat = fmtUsd, color = "#2563eb", secondaryKey = null } = {}) {
  const container = $(containerId);
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">${esc(t("noData"))}</div>`;
    return;
  }
  const width = 760;
  const height = 320;
  const pad = { top: 22, right: 24, bottom: 34, left: 62 };
  const values = rows.map((row) => Number(row[valueKey] || 0));
  const minYear = Math.min(...rows.map((row) => row.year_num));
  const maxYear = Math.max(...rows.map((row) => row.year_num));
  const maxValue = Math.max(...values) * 1.08;
  const minValue = Math.min(0, Math.min(...values));
  const x = (year) => pad.left + ((year - minYear) / (maxYear - minYear || 1)) * (width - pad.left - pad.right);
  const y = (value) =>
    height - pad.bottom - ((value - minValue) / (maxValue - minValue || 1)) * (height - pad.top - pad.bottom);
  const points = rows.map((row) => `${x(row.year_num).toFixed(2)},${y(Number(row[valueKey] || 0)).toFixed(2)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((gridPosition) => {
    const gy = pad.top + gridPosition * (height - pad.top - pad.bottom);
    const val = maxValue - gridPosition * (maxValue - minValue);
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" stroke="#e5e9ed"/><text x="8" y="${gy + 4}" fill="#68727c" font-size="11">${esc(yFormat(val))}</text>`;
  });
  const labels = rows
    .filter((row) => [2026, 2030, 2035, 2040, 2045].includes(row.year_num))
    .map(
      (row) =>
        `<text x="${x(row.year_num)}" y="${height - 10}" fill="#68727c" font-size="11" text-anchor="middle">${row.year_num}</text>`,
    );
  const dots = rows
    .filter((row) => [2026, 2030, 2045].includes(row.year_num))
    .map((row) => {
      const cx = x(row.year_num);
      const cy = y(Number(row[valueKey] || 0));
      return `<circle cx="${cx}" cy="${cy}" r="4" fill="${color}"><title>${row.year_num}: ${yFormat(row[valueKey])}</title></circle>`;
    });
  let secondary = "";
  if (secondaryKey) {
    const secMax = Math.max(...rows.map((row) => Number(row[secondaryKey] || 0)), 0.01) * 1.2;
    const secY = (value) => height - pad.bottom - (value / secMax) * (height - pad.top - pad.bottom);
    const secPoints = rows.map((row) => `${x(row.year_num).toFixed(2)},${secY(Number(row[secondaryKey] || 0)).toFixed(2)}`).join(" ");
    secondary = `<polyline points="${secPoints}" fill="none" stroke="#b45309" stroke-width="2" stroke-dasharray="5 5"/>`;
  }
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">
      ${grid.join("")}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="#cfd6dc"/>
      ${labels.join("")}
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>
      ${secondary}
      ${dots.join("")}
    </svg>`;
}

function renderDateLineChart(containerId, rows, valueKey, { yFormat = (value) => fmtNumber(value, 1), color = "#2563eb" } = {}) {
  const container = $(containerId);
  if (!rows?.length) {
    container.innerHTML = `<div class="empty-state">${esc(t("noData"))}</div>`;
    return;
  }
  const width = 760;
  const height = 300;
  const pad = { top: 22, right: 24, bottom: 42, left: 58 };
  const values = rows.map((row) => Number(row[valueKey] || 0));
  const maxValue = Math.max(...values) * 1.04;
  const minValue = Math.min(...values) * 0.96;
  const x = (index) => pad.left + (index / Math.max(rows.length - 1, 1)) * (width - pad.left - pad.right);
  const y = (value) =>
    height - pad.bottom - ((value - minValue) / (maxValue - minValue || 1)) * (height - pad.top - pad.bottom);
  const points = rows.map((row, index) => `${x(index).toFixed(2)},${y(Number(row[valueKey] || 0)).toFixed(2)}`).join(" ");
  const grid = [0, 0.5, 1].map((gridPosition) => {
    const gy = pad.top + gridPosition * (height - pad.top - pad.bottom);
    const val = maxValue - gridPosition * (maxValue - minValue);
    return `<line x1="${pad.left}" x2="${width - pad.right}" y1="${gy}" y2="${gy}" stroke="#e5e9ed"/><text x="8" y="${gy + 4}" fill="#68727c" font-size="11">${esc(yFormat(val))}</text>`;
  });
  const labelRows = [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].filter(Boolean);
  const labels = labelRows.map((row) => {
    const index = rows.indexOf(row);
    return `<text x="${x(index)}" y="${height - 14}" fill="#68727c" font-size="11" text-anchor="middle">${esc(row.date)}</text>`;
  });
  container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Date line chart">
      ${grid.join("")}
      <line x1="${pad.left}" x2="${width - pad.right}" y1="${height - pad.bottom}" y2="${height - pad.bottom}" stroke="#cfd6dc"/>
      ${labels.join("")}
      <polyline points="${points}" fill="none" stroke="${color}" stroke-width="3"/>
    </svg>`;
}

function renderBars(containerId, rows, { labelKey = "item_name", valueKey = "amount_usd_bn", maxRows = 10, valueFormat = fmtUsd } = {}) {
  const container = $(containerId);
  const data = rows.slice(0, maxRows);
  if (!data.length) {
    container.innerHTML = `<div class="empty-state">${esc(t("noData"))}</div>`;
    return;
  }
  const max = Math.max(...data.map((row) => Number(row[valueKey] || 0)), 1);
  container.innerHTML = data
    .map((row, index) => {
      const value = Number(row[valueKey] || 0);
      const width = Math.max(1, (value / max) * 100);
      return `
        <div class="bar-row">
          <div class="label" title="${esc(row[labelKey])}">${esc(row[labelKey])}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${width}%;background:${colors[index % colors.length]}"></div></div>
          <div class="value">${esc(valueFormat(value, row))}</div>
        </div>`;
    })
    .join("");
}

function renderBreakdownTable(rows) {
  $("breakdownTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.item_name)}</td>
          <td class="num">${fmtPct(row.share_of_global, 2)}</td>
          <td class="num">${fmtUsd(row.amount_usd_bn)}</td>
        </tr>`,
    )
    .join("");
}

function renderBridgeTable(rows) {
  $("bridgeTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.country_name)}</td>
          <td>${esc(row.company_name)}</td>
          <td>${esc(row.component_name)}</td>
          <td class="num">${fmtUsd(row.amount_usd_bn)}</td>
        </tr>`,
    )
    .join("");
}

function renderSources(rows) {
  $("sourcesTable").innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.source_id)}</td>
          <td>${esc(row.theme)}</td>
          <td>${row.url ? `<a href="${esc(row.url)}" target="_blank" rel="noreferrer">${esc(row.key_fact)}</a>` : esc(row.key_fact)}</td>
          <td>${esc(row.source_type)}</td>
        </tr>`,
    )
    .join("");
}

function fmtNumber(value, digits = 2) {
  if (value === null || value === undefined || value === "") return "-";
  const number = Number(value);
  if (Number.isNaN(number)) return String(value);
  return number.toLocaleString(localeByLanguage[state.language] || "zh-CN", {
    maximumFractionDigits: digits,
  });
}

function emptyRow(colspan) {
  return `<tr><td colspan="${colspan}" class="empty-cell">${esc(t("noData"))}</td></tr>`;
}

function renderArtifact(artifact) {
  const container = $("artifactGrid");
  if (!container) return;
  if (!artifact) {
    container.innerHTML = `<div class="empty-state">${esc(t("noArtifact"))}</div>`;
    return;
  }
  const rows = [
    [t("runId"), artifact.run_id],
    [t("pipelineId"), artifact.pipeline_id],
    [t("generatedWorkbook"), artifact.generated_workbook_path],
    [t("sourceWorkbook"), artifact.source_workbook_path],
    [t("sourceSnapshot"), artifact.source_snapshot_path],
    [t("adjustmentFile"), artifact.adjustment_path],
    [t("manifestFile"), artifact.manifest_path],
    [t("generatedAt"), fmtDateTime(artifact.generated_at)],
    [t("importTrigger"), artifact.import_trigger],
  ];
  container.innerHTML = rows
    .map(
      ([label, value]) => `
        <div class="meta-row">
          <span>${esc(label)}</span>
          <strong title="${esc(value || "-")}">${esc(value || "-")}</strong>
        </div>`,
    )
    .join("");
}

function renderExternalSources(rows) {
  $("externalSourcesTable").innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${esc(row.source_name || row.source_id)}</td>
              <td>${esc(row.status || "-")}</td>
              <td>${esc(row.latest_date || "-")}</td>
              <td class="num">${esc(fmtNumber(row.latest_value))}</td>
              <td class="num">${esc(row.yoy === null || row.yoy === undefined ? "-" : fmtPct(row.yoy))}</td>
              <td class="num">${esc(fmtNumber(row.row_count, 0))}</td>
            </tr>`,
        )
        .join("")
    : emptyRow(6);
}

function renderModelAdjustments(rows) {
  $("modelAdjustmentsTable").innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${esc(row.driver_name)}</td>
              <td class="num">${esc(row.year_num)}</td>
              <td class="num">${esc(fmtNumber(row.baseline_contribution, 4))}</td>
              <td class="num">${esc(fmtNumber(row.adjusted_contribution, 4))}</td>
              <td class="num">${esc(fmtNumber(row.delta_contribution, 4))}</td>
              <td>${esc(row.signal_name || "-")}</td>
              <td>${esc(row.rationale || "-")}</td>
            </tr>`,
        )
        .join("")
    : emptyRow(7);
}

function populateManagedUserTierOptions(selected = null) {
  const select = $("managedUserTier");
  if (!select) return;
  const current = selected || select.value || "pro";
  select.innerHTML = state.managedUserTiers
    .map((tier) => `<option value="${esc(tier)}">${esc(t(`tier_${tier}`))}</option>`)
    .join("");
  select.value = state.managedUserTiers.includes(current) ? current : "pro";
}

function resetManagedUserForm() {
  state.editingUserId = null;
  $("userForm").reset();
  $("managedUserEmail").disabled = false;
  $("managedUserActive").checked = true;
  populateManagedUserTierOptions("pro");
  $("userFormTitle").textContent = t("createUser");
  $("userFormMode").textContent = t("newAccount");
  $("managedUserPassword").placeholder = "";
  $("userFormMessage").textContent = "";
}

function editManagedUser(userId) {
  const user = state.managedUsers.find((item) => Number(item.user_id) === Number(userId));
  if (!user) return;
  state.editingUserId = user.user_id;
  $("managedUserEmail").value = user.email || "";
  $("managedUserEmail").disabled = true;
  $("managedUserName").value = user.display_name || "";
  populateManagedUserTierOptions(user.tier);
  $("managedUserActive").checked = Boolean(user.active);
  $("managedUserPassword").value = "";
  $("managedUserPassword").placeholder = t("passwordOptionalOnEdit");
  $("userFormTitle").textContent = t("editUser");
  $("userFormMode").textContent = t("editingAccount");
  $("userFormMessage").textContent = "";
}

function renderManagedUsers(rows) {
  state.managedUsers = rows || [];
  const body = $("usersTable");
  if (!body) return;
  body.innerHTML = state.managedUsers.length
    ? state.managedUsers
        .map(
          (user) => `
            <tr>
              <td>${esc(user.email)}</td>
              <td>${esc(user.display_name || "-")}</td>
              <td>${esc(t(`tier_${user.tier}`))}</td>
              <td>${esc(user.active ? t("active") : t("inactive"))}</td>
              <td>${esc(fmtDateTime(user.last_login_at))}</td>
              <td><button class="table-action" type="button" data-edit-user="${esc(user.user_id)}">${esc(t("edit"))}</button></td>
            </tr>`,
        )
        .join("")
    : emptyRow(6);
}

async function loadUsers() {
  const data = await api("/api/users");
  state.managedUserTiers = data.tiers || state.managedUserTiers;
  populateManagedUserTierOptions($("managedUserTier")?.value || "pro");
  renderManagedUsers(data.rows || []);
  $("usersStatus").textContent = `${data.rows?.length || 0}`;
  $("usersStatus").className = "status-pill ok";
}

async function saveManagedUser(event) {
  event.preventDefault();
  $("userFormMessage").textContent = "";
  const isEditing = Boolean(state.editingUserId);
  const password = $("managedUserPassword").value;
  if (!isEditing && !password) {
    $("userFormMessage").textContent = t("passwordRequired");
    return;
  }
  const payload = {
    display_name: $("managedUserName").value.trim(),
    tier: $("managedUserTier").value,
    active: $("managedUserActive").checked,
  };
  if (!isEditing) payload.email = $("managedUserEmail").value.trim();
  if (password) payload.password = password;

  $("saveManagedUser").disabled = true;
  try {
    await api(isEditing ? `/api/users/${state.editingUserId}` : "/api/users", {
      method: isEditing ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    $("userFormMessage").textContent = t("userSaved");
    resetManagedUserForm();
    await loadUsers();
  } catch (error) {
    $("userFormMessage").textContent = error.message;
  } finally {
    $("saveManagedUser").disabled = false;
  }
}

function renderPlans(plans) {
  state.plans = plans || [];
  const currentTier = state.user?.tier || "free";
  $("subscriptionStatus").textContent = `${t("currentPlan")}: ${t(`tier_${currentTier}`)}`;
  $("subscriptionStatus").className = "status-pill ok";
  $("plansGrid").innerHTML = state.plans
    .map((plan) => {
      const isCurrent = plan.id === currentTier || (currentTier === "admin" && plan.id === "enterprise");
      const canManageBilling = isCurrent && plan.id !== "free" && Boolean(state.user?.billing_portal_available);
      const subscriptionButtonLabel =
        plan.id === "free"
          ? t("useFreePlan")
          : canManageBilling
            ? t("manageBilling")
            : isCurrent
              ? t("currentPlan")
              : state.user?.is_guest
                ? t("signInRegister")
                : t("subscribe");
      const oneTimeButtonLabel = state.user?.is_guest ? t("signInRegister") : t("oneTimePayment");
      const monthlyPrice = Number(plan.price_monthly_cny || 0);
      const oneTimePrice = Number(plan.price_one_time_cny || plan.price_monthly_cny || 0);
      const accessDays = Number(plan.one_time_access_days || 30);
      const monthlyAvailable = plan.id === "free" || Boolean(plan.stripe_price_configured);
      const oneTimeAvailable = Boolean(plan.stripe_one_time_price_configured);
      return `
        <section class="plan-card">
          <div class="plan-head">
            <h3>${esc(plan.name || t(`tier_${plan.id}`))}</h3>
            <strong>${monthlyPrice === 0 ? fmtCny(0) : fmtCny(monthlyPrice)}</strong>
            <span>/ ${esc(t("monthlySubscription"))}</span>
          </div>
          <p>${esc(plan.audience || "")}</p>
          <ul>
            ${(plan.features || []).map((feature) => `<li>${esc(feature)}</li>`).join("")}
          </ul>
          <div class="plan-actions">
            <button class="plan-button" type="button" ${canManageBilling ? "data-billing-portal=\"true\"" : `data-plan-id="${esc(plan.id)}" data-checkout-mode="subscription"`}${(isCurrent && !canManageBilling) || !monthlyAvailable ? " disabled" : ""}>
              ${esc(subscriptionButtonLabel)}
            </button>
            ${
              plan.id === "free"
                ? ""
                : `<button class="plan-button secondary" type="button" data-plan-id="${esc(plan.id)}" data-checkout-mode="one_time"${isCurrent || !oneTimeAvailable ? " disabled" : ""}>
                    ${esc(oneTimeButtonLabel)} · ${esc(fmtCny(oneTimePrice))} · ${esc(t("oneTimeAccess", { days: accessDays }))}
                  </button>`
            }
          </div>
          <small>${esc(
            plan.id === "free"
              ? t("tier_free")
              : plan.stripe_price_configured && plan.stripe_one_time_price_configured
                ? `${t("paymentProviderStripe")} / ${t("paymentProviderStripeOneTime")}`
                : t("paymentUnavailable"),
          )}</small>
        </section>`;
    })
    .join("");
}

async function loadPlans() {
  const data = await api("/api/plans");
  renderPlans(data.plans || []);
}

async function openBillingPortal() {
  $("plansMessage").textContent = "";
  try {
    const result = await api("/api/subscriptions/portal", {
      method: "POST",
      body: JSON.stringify({ return_url: `${window.location.origin}/#plans` }),
    });
    if (result.portal_url) window.location.href = result.portal_url;
  } catch (error) {
    $("plansMessage").textContent =
      error.code === "payment_not_configured"
        ? t("paymentNotConfigured")
        : error.code === "billing_profile_missing"
          ? t("billingProfileMissing")
          : error.message;
  }
}

async function startCheckout(planId, checkoutMode = "subscription") {
  $("plansMessage").textContent = "";
  if (state.user?.is_guest && planId !== "free") {
    $("plansMessage").textContent = t("registerBeforeSubscribe");
    showLogin();
    setAuthMode("register");
    return;
  }
  try {
    const result = await api("/api/subscriptions/checkout", {
      method: "POST",
      body: JSON.stringify({
        plan_id: planId,
        checkout_mode: checkoutMode,
        success_url: `${window.location.origin}/?checkout=success`,
        cancel_url: `${window.location.origin}/?checkout=cancel`,
        locale: state.language,
      }),
    });
    if (result.mode === "stripe" && result.checkout_url) {
      $("plansMessage").textContent = t("paymentPending");
      window.location.href = result.checkout_url;
      return;
    }
    if (result.user) {
      state.user = result.user;
      renderAccount();
      applyPermissions();
      await loadAvailableData();
    }
    $("plansMessage").textContent = result.message || "";
  } catch (error) {
    $("plansMessage").textContent =
      error.status === 401
        ? t("registerBeforeSubscribe")
        : error.code === "payment_not_configured"
          ? t("paymentNotConfigured")
          : error.message;
  }
}

async function loadOverview() {
  const [health, summary, global] = await Promise.all([api("/api/health"), api("/api/summary"), api("/api/global")]);
  $("healthStatus").textContent = health.ok ? t("connected") : t("degraded");
  $("healthStatus").className = `status-pill ${health.ok ? "ok" : "error"}`;
  $("runLabel").textContent = summary.run.run_id;
  renderKpis(summary);
  renderLineChart("globalLine", global.rows, "total_usd_bn");
  await loadMix();
}

async function loadMix() {
  const data = await api(`/api/breakdown/${state.mixDimension}?year=2030&limit=10`);
  renderBars("mixBars", data.rows, { maxRows: 10 });
}

async function loadEntityComponents() {
  const params = new URLSearchParams({
    entity_type: state.entityType,
    entity_name: state.entityName,
    year: state.selectedYear,
  });
  const data = await api(`/api/entity-components?${params}`);
  $("componentTitle").textContent = t("componentAllocationFor", { name: state.entityName });
  renderBars("componentBars", data.rows, {
    labelKey: "component_name",
    maxRows: 18,
    valueFormat: (value, row) => `${fmtUsd(value)} · ${fmtPct(row.component_share)}`,
  });
}

async function loadBreakdown() {
  const data = await api(`/api/breakdown/${state.breakdownDimension}?year=${state.selectedYear}&limit=16`);
  $("breakdownCaption").textContent = t("rankingFor", {
    dimension: t(state.breakdownDimension),
    year: state.selectedYear,
  });
  renderBreakdownTable(data.rows);
}

async function loadBridge() {
  const params = new URLSearchParams({ year: state.selectedYear, limit: 80 });
  if (state.bridgeCountry) params.set("country", state.bridgeCountry);
  if (state.bridgeCompany) params.set("company", state.bridgeCompany);
  const data = await api(`/api/country-company-components?${params}`);
  $("bridgeCaption").textContent = t("allocationRows", { year: state.selectedYear });
  renderBridgeTable(data.rows);
}

async function loadFinance() {
  const [funding, finance] = await Promise.all([
    api(`/api/funding?company=${encodeURIComponent(state.financeCompany)}&year=${state.selectedYear}`),
    api(`/api/finance?company=${encodeURIComponent(state.financeCompany)}`),
  ]);
  $("fundingCaption").textContent = t("companyYear", { company: state.financeCompany, year: state.selectedYear });
  renderBars("fundingBars", funding.rows, {
    labelKey: "funding_source",
    valueKey: "amount_funded_usd_bn",
    maxRows: 8,
    valueFormat: (value, row) => `${fmtUsd(value)} · ${fmtPct(row.share_of_annual_investment)}`,
  });
  renderLineChart("roicLine", finance.rows, "implied_roic", {
    yFormat: (value) => fmtPct(value),
    color: "#0f766e",
    secondaryKey: "weighted_all_in_funding_cost",
  });
}

function marketStatusLabel(status) {
  if (status === "strong") return state.language === "zh" ? "强" : "Strong";
  if (status === "mixed") return state.language === "zh" ? "中性" : "Mixed";
  if (status === "weak") return state.language === "zh" ? "弱" : "Weak";
  return "-";
}

function renderHardwareScorecards(market) {
  const container = $("hardwareScoreGrid");
  if (!market?.tracks?.length) {
    container.innerHTML = `<div class="empty-state">${esc(t("noData"))}</div>`;
    return;
  }
  container.innerHTML = market.tracks
    .map(
      (track) => `
        <button class="score-card${track.track_id === state.hardwareTrack ? " active" : ""}" type="button" data-track-id="${esc(track.track_id)}">
          <span>${esc(track.short_name || track.display_name)}</span>
          <strong>${track.score === null ? "-" : `${track.score}`}</strong>
          <small>${esc(marketStatusLabel(track.status))} · ${esc(track.above_sma20)}/${esc(track.priced_constituents)} ${esc(t("above20Day"))}</small>
        </button>`,
    )
    .join("");
}

function renderHardwareBreadthHistory(market) {
  const head = $("hardwareBreadthHistoryHead");
  const body = $("hardwareBreadthHistoryTable");
  const tracks = market?.tracks || [];
  const rows = market?.breadth_history || [];
  if (!tracks.length || !rows.length) {
    head.innerHTML = "";
    body.innerHTML = emptyRow(2);
    return;
  }
  head.innerHTML = `
    <tr>
      <th>${esc(t("date"))}</th>
      ${tracks.map((track) => `<th>${esc(track.short_name || track.display_name)}</th>`).join("")}
      <th>${esc(t("totalBreadth"))}</th>
    </tr>`;
  body.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${esc(row.date)}</td>
          ${tracks
            .map((track) => {
              const score = row.scores?.[track.track_id];
              return `<td class="num">${score === null || score === undefined ? "-" : esc(score)}</td>`;
            })
            .join("")}
          <td class="num">${esc(row.total_score)} / ${esc(row.max_score)}</td>
        </tr>`,
    )
    .join("");
}

function renderHardwareConstituents(track) {
  const rows = track?.constituents || [];
  $("hardwareConstituentsTable").innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${esc(row.symbol)}</td>
              <td>${esc(row.company_name)}</td>
              <td class="num">${esc(fmtPrice(row.price))}</td>
              <td class="num">${esc(fmtPrice(row.sma20))}</td>
              <td class="num">${esc(fmtPrice(row.sma50))}</td>
              <td class="num">${row.return_20d === null || row.return_20d === undefined ? "-" : esc(fmtPct(row.return_20d))}</td>
            </tr>`,
        )
        .join("")
    : emptyRow(6);
}

function renderHardwareMarket(market) {
  state.hardwareMarket = market;
  const status = $("hardwareMarketStatus");
  if (!market?.tracks?.length) {
    status.textContent = t("noData");
    status.className = "status-pill error";
    renderHardwareScorecards(null);
    renderHardwareBreadthHistory(null);
    renderDateLineChart("hardwareTrackLine", [], "index_level");
    renderHardwareConstituents(null);
    return;
  }
  status.textContent = `${t("score")} ${market.total_score}/${market.max_score}`;
  status.className = "status-pill ok";
  renderHardwareScorecards(market);
  renderHardwareBreadthHistory(market);
  const selected = market.tracks.find((track) => track.track_id === state.hardwareTrack) || market.tracks[0];
  state.hardwareTrack = selected.track_id;
  $("hardwareTrackSelect").value = selected.track_id;
  $("hardwareTrackMeta").textContent = `${t("asOf")} ${selected.constituents?.[0]?.as_of || market.as_of.slice(0, 10)} · ${t("above50Day")} ${selected.above_sma50}/${selected.priced_constituents}`;
  renderDateLineChart("hardwareTrackLine", selected.index_series || [], "index_level");
  renderHardwareConstituents(selected);
}

function renderCapexSplitTable(rows) {
  $("capexSplitTable").innerHTML = rows.length
    ? rows
        .map(
          (row) => `
            <tr>
              <td>${esc(row.display_name)}</td>
              <td class="num">${esc(fmtUsd(row.amount_usd_bn))}</td>
              <td class="num">${esc(fmtPct(row.split_share))}</td>
              <td>${esc(row.basis || "-")}</td>
            </tr>`,
        )
        .join("")
    : emptyRow(4);
}

function renderCapexSplitDetail(data) {
  const splits = data.capex_splits || [];
  const select = $("capexSplitSelect");
  select.innerHTML = splits
    .map((split) => `<option value="${esc(split.split_id)}">${esc(split.display_name)}</option>`)
    .join("");
  if (!splits.some((split) => split.split_id === state.capexSplitView)) {
    state.capexSplitView = splits[0]?.split_id || "all_components";
  }
  select.value = state.capexSplitView;
  const selected = splits.find((split) => split.split_id === state.capexSplitView) || splits[0];
  if (!selected) {
    $("capexSplitTotal").textContent = t("noData");
    renderBars("capexSplitBars", [], {});
    renderCapexSplitTable([]);
    return;
  }
  $("capexSplitTotal").textContent = `${selected.display_name} · ${fmtUsd(selected.total_usd_bn)}`;
  renderBars("capexSplitBars", selected.rows || [], {
    labelKey: "display_name",
    valueKey: "amount_usd_bn",
    maxRows: 12,
    valueFormat: (value, row) => `${fmtUsd(value)} · ${fmtPct(row.split_share)}`,
  });
  renderCapexSplitTable(selected.rows || []);
}

function renderHardwareDashboard(data) {
  state.hardwareDashboard = data;
  const definitions = data.definitions || [];
  const trackOptions = definitions
    .map((track) => `<option value="${esc(track.track_id)}">${esc(track.display_name)}</option>`)
    .join("");
  $("hardwareTrackSelect").innerHTML = trackOptions;
  if (!definitions.some((track) => track.track_id === state.hardwareTrack)) {
    state.hardwareTrack = definitions[0]?.track_id || "optical_interconnect";
  }
  $("hardwareTrackSelect").value = state.hardwareTrack;

  renderBars("hardwareCapexBars", data.tracks || [], {
    labelKey: "display_name",
    valueKey: "amount_usd_bn",
    maxRows: 10,
    valueFormat: (value, row) => `${fmtUsd(value)} · ${fmtPct(row.share_of_global)}`,
  });
  renderCapexSplitDetail(data);
}

async function loadHardware() {
  const [dashboard, market] = await Promise.all([
    api(`/api/hardware-dashboard?year=${state.selectedYear}`),
    api("/api/hardware-market-breadth").catch((error) => {
      console.error(error);
      return null;
    }),
  ]);
  renderHardwareDashboard(dashboard);
  renderHardwareMarket(market);
}

async function loadSources() {
  const data = await api("/api/sources?limit=80");
  renderSources(data.rows);
}

function fmtDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(localeByLanguage[state.language] || "zh-CN");
}

function updateHeaders() {
  const headers = { "Content-Type": "application/json" };
  const token = $("updateTokenInput").value.trim();
  if (token) headers["x-recalculate-token"] = token;
  return headers;
}

function setUpdateBusy(busy) {
  $("saveUpdateConfig").disabled = busy;
  $("runUpdateNow").disabled = busy;
  $("refreshUpdateStatus").disabled = busy;
}

function renderUpdateStatus(data) {
  state.updateStatus = data;
  const modeOptions = data.modes
    .map((mode) => `<option value="${esc(mode.id)}">${esc(t(`mode_${mode.id}`) || mode.label)}</option>`)
    .join("");
  $("updateModeSelect").innerHTML = modeOptions;
  $("updateModeSelect").value = data.config.mode;
  $("updateScheduleType").value = data.config.schedule_type || "interval";
  $("updateIntervalInput").value = data.config.interval_hours;
  $("updateWeeklyDay").value = String(data.config.weekly_day ?? 0);
  $("updateWeeklyTime").value = data.config.weekly_time || "00:00";
  $("autoUpdateEnabled").checked = Boolean(data.config.enabled);
  $("nextUpdateAt").textContent = fmtDateTime(data.next_run_at);
  $("lastUpdateAt").textContent = fmtDateTime(data.finished_at);
  $("lastUpdateExit").textContent = data.exit_code === null ? "-" : String(data.exit_code);

  if (data.running) {
    $("updateStatus").textContent = t("running");
    $("updateStatus").className = "status-pill";
  } else if (data.config.enabled) {
    $("updateStatus").textContent = t("scheduled");
    $("updateStatus").className = "status-pill ok";
  } else {
    $("updateStatus").textContent = data.access_enabled ? t("manual") : t("disabled");
    $("updateStatus").className = data.access_enabled ? "status-pill" : "status-pill error";
  }

  const output = data.last_output || "";
  $("updateOutput").textContent = output;
  $("updateOutput").className = `update-output${output ? " has-output" : ""}`;
}

async function loadUpdateStatus() {
  const data = await api("/api/update/status");
  renderUpdateStatus(data);
}

async function loadLatestArtifact() {
  try {
    const data = await api("/api/artifacts");
    const archivePath = data.artifact?.generated_workbook_path || "-";
    if ($("latestArchivePath")) {
      $("latestArchivePath").textContent = archivePath;
      $("latestArchivePath").title = archivePath === "-" ? "" : archivePath;
    }
    renderArtifact(data.artifact);
  } catch (error) {
    console.error(error);
    if ($("latestArchivePath")) {
      $("latestArchivePath").textContent = "-";
      $("latestArchivePath").title = "";
    }
    renderArtifact(null);
  }
}

async function loadAudit() {
  const [sources, adjustments] = await Promise.all([
    api("/api/external-sources"),
    api("/api/model-adjustments?limit=120"),
    loadLatestArtifact(),
  ]);
  renderExternalSources(sources.rows);
  renderModelAdjustments(adjustments.rows);
}

function startUpdatePolling() {
  if (state.updatePollTimer || !can("automation")) return;
  state.updatePollTimer = window.setInterval(async () => {
    const previousFinish = state.updateStatus?.finished_at || null;
    try {
      await loadUpdateStatus();
      if (state.updateStatus?.finished_at && state.updateStatus.finished_at !== previousFinish) {
        await loadAvailableData();
      }
    } catch (error) {
      console.error(error);
    }
  }, updatePollIntervalMs);
}

function stopUpdatePolling() {
  if (!state.updatePollTimer) return;
  window.clearInterval(state.updatePollTimer);
  state.updatePollTimer = null;
}

async function saveUpdateConfig() {
  setUpdateBusy(true);
  try {
    const data = await api("/api/update/config", {
      method: "POST",
      headers: updateHeaders(),
      body: JSON.stringify({
        mode: $("updateModeSelect").value,
        schedule_type: $("updateScheduleType").value,
        interval_hours: Number($("updateIntervalInput").value),
        weekly_day: Number($("updateWeeklyDay").value),
        weekly_time: $("updateWeeklyTime").value,
        enabled: $("autoUpdateEnabled").checked,
      }),
    });
    renderUpdateStatus(data);
  } catch (error) {
    $("updateOutput").textContent = error.status === 403 ? t("accessDenied") : error.message;
    $("updateOutput").className = "update-output has-output";
  } finally {
    setUpdateBusy(false);
  }
}

async function runUpdateNow() {
  setUpdateBusy(true);
  $("updateStatus").textContent = t("running");
  $("updateStatus").className = "status-pill";
  try {
    const result = await api("/api/update/run", {
      method: "POST",
      headers: updateHeaders(),
      body: JSON.stringify({ mode: $("updateModeSelect").value }),
    });
    $("updateOutput").textContent = result.job?.last_output || "";
    $("updateOutput").className = `update-output${result.job?.last_output ? " has-output" : ""}`;
    await loadAvailableData();
  } catch (error) {
    $("updateStatus").textContent = t("error");
    $("updateStatus").className = "status-pill error";
    $("updateOutput").textContent = error.status === 403 ? t("accessDenied") : error.message;
    $("updateOutput").className = "update-output has-output";
  } finally {
    setUpdateBusy(false);
  }
}

function populateOptionControls() {
  if (!state.options) return;
  const countries = state.options.countries || [];
  const companies = state.options.companies || [];
  const years = state.options.years || [];
  state.selectedYear = years.includes(state.selectedYear) ? state.selectedYear : years[0] || state.selectedYear;
  state.entityName = countries.includes(state.entityName) ? state.entityName : countries[0] || "";
  state.financeCompany = companies.includes(state.financeCompany) ? state.financeCompany : companies[0] || "";
  if (state.entityType === "company") {
    state.entityName = companies.includes(state.entityName) ? state.entityName : companies[0] || "";
  }
  setSelectOptions(
    $("yearSelect"),
    years.map((year) => String(year)),
    String(state.selectedYear),
  );
  setSelectOptions($("entityNameSelect"), state.entityType === "country" ? countries : companies, state.entityName);
  setSelectOptions($("bridgeCountrySelect"), countries, state.bridgeCountry, true);
  setSelectOptions($("bridgeCompanySelect"), companies, state.bridgeCompany, true);
  setSelectOptions($("financeCompanySelect"), companies, state.financeCompany);
}

async function loadAvailableData() {
  const tasks = [];
  if (can("overview")) tasks.push(loadOverview());
  if (can("breakdowns")) tasks.push(loadEntityComponents(), loadBreakdown());
  if (can("bridge")) tasks.push(loadBridge());
  if (can("finance")) tasks.push(loadFinance());
  if (can("hardware")) tasks.push(loadHardware());
  if (can("sources")) tasks.push(loadSources());
  if (can("artifacts")) tasks.push(loadAudit());
  if (can("automation")) tasks.push(loadUpdateStatus());
  if (can("admin")) tasks.push(loadUsers());
  if (can("plans")) tasks.push(loadPlans());
  await Promise.all(tasks);
}

function wireDashboardControls() {
  if (state.controlsWired) return;
  state.controlsWired = true;

  $("mixTabs").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || !can("overview")) return;
    state.mixDimension = button.dataset.dimension;
    document.querySelectorAll("#mixTabs button").forEach((item) => item.classList.toggle("active", item === button));
    await loadMix();
  });

  $("breakdownTabs").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || !can("breakdowns")) return;
    state.breakdownDimension = button.dataset.dimension;
    document.querySelectorAll("#breakdownTabs button").forEach((item) => item.classList.toggle("active", item === button));
    await loadBreakdown();
  });

  $("entityTypeSelect").addEventListener("change", async (event) => {
    if (!can("breakdowns")) return;
    state.entityType = event.target.value;
    const list = state.entityType === "country" ? state.options.countries : state.options.companies;
    state.entityName = list[0] || "";
    setSelectOptions($("entityNameSelect"), list, state.entityName);
    await loadEntityComponents();
  });

  $("entityNameSelect").addEventListener("change", async (event) => {
    if (!can("breakdowns")) return;
    state.entityName = event.target.value;
    await loadEntityComponents();
  });

  $("yearSelect").addEventListener("change", async (event) => {
    state.selectedYear = Number(event.target.value);
    const tasks = [];
    if (can("breakdowns")) tasks.push(loadEntityComponents(), loadBreakdown());
    if (can("bridge")) tasks.push(loadBridge());
    if (can("finance")) tasks.push(loadFinance());
    if (can("hardware")) tasks.push(loadHardware());
    await Promise.all(tasks);
  });

  $("bridgeCountrySelect").addEventListener("change", async (event) => {
    if (!can("bridge")) return;
    state.bridgeCountry = event.target.value;
    await loadBridge();
  });

  $("bridgeCompanySelect").addEventListener("change", async (event) => {
    if (!can("bridge")) return;
    state.bridgeCompany = event.target.value;
    await loadBridge();
  });

  $("financeCompanySelect").addEventListener("change", async (event) => {
    if (!can("finance")) return;
    state.financeCompany = event.target.value;
    await loadFinance();
  });

  $("hardwareTrackSelect").addEventListener("change", (event) => {
    if (!can("hardware")) return;
    state.hardwareTrack = event.target.value;
    renderHardwareMarket(state.hardwareMarket);
  });

  $("hardwareScoreGrid").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-track-id]");
    if (!button || !can("hardware")) return;
    state.hardwareTrack = button.dataset.trackId;
    renderHardwareMarket(state.hardwareMarket);
  });

  $("capexSplitSelect").addEventListener("change", (event) => {
    if (!can("hardware")) return;
    state.capexSplitView = event.target.value;
    renderCapexSplitDetail(state.hardwareDashboard || {});
  });

  $("saveUpdateConfig").addEventListener("click", async () => {
    if (can("automation")) await saveUpdateConfig();
  });

  $("runUpdateNow").addEventListener("click", async () => {
    if (can("automation")) await runUpdateNow();
  });

  $("refreshUpdateStatus").addEventListener("click", async () => {
    if (can("automation")) await loadUpdateStatus();
  });

  $("userForm").addEventListener("submit", async (event) => {
    if (can("admin")) await saveManagedUser(event);
  });

  $("resetManagedUserForm").addEventListener("click", () => {
    if (can("admin")) resetManagedUserForm();
  });

  $("refreshUsers").addEventListener("click", async () => {
    if (can("admin")) await loadUsers();
  });

  $("usersTable").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-edit-user]");
    if (!button || !can("admin")) return;
    editManagedUser(button.dataset.editUser);
  });

  $("plansGrid").addEventListener("click", async (event) => {
    const portalButton = event.target.closest("button[data-billing-portal]");
    if (portalButton && can("plans")) {
      await openBillingPortal();
      return;
    }
    const button = event.target.closest("button[data-plan-id]");
    if (!button || !can("plans")) return;
    await startCheckout(button.dataset.planId, button.dataset.checkoutMode || "subscription");
  });
}

function wireShellControls() {
  if (state.shellWired) return;
  state.shellWired = true;

  for (const id of ["languageSelect", "loginLanguageSelect"]) {
    $(id).addEventListener("change", async (event) => {
      await setLanguage(event.target.value);
    });
  }

  $("authTabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-auth-mode]");
    if (button) setAuthMode(button.dataset.authMode);
  });

  $("continueGuestButton").addEventListener("click", async () => {
    try {
      const data = await api("/api/auth/me");
      state.user = data.user;
      showApp();
      await initDashboard();
    } catch (error) {
      console.error(error);
    }
  });

  $("loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("loginError").textContent = "";
    try {
      const data = await api(state.authMode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("registerName").value.trim(),
          email: $("loginEmail").value.trim(),
          password: $("loginPassword").value,
        }),
      });
      state.user = data.user;
      showApp();
      await initDashboard();
    } catch (error) {
      console.error(error);
      $("loginError").textContent = error.status === 401 ? t("invalidLogin") : error.message;
    }
  });

  $("logoutButton").addEventListener("click", async () => {
    if (state.user?.is_guest) {
      showLogin();
      return;
    }
    try {
      await api("/api/auth/logout", { method: "POST" });
      const data = await api("/api/auth/me");
      state.user = data.user;
      showApp();
      await initDashboard();
    } catch (error) {
      console.error(error);
    }
  });

  document.querySelectorAll(".nav-list a").forEach((link) => {
    link.addEventListener("click", () => {
      document.querySelectorAll(".nav-list a").forEach((item) => item.classList.toggle("active", item === link));
    });
  });
}

async function initDashboard() {
  try {
    state.options = await api("/api/options");
    populateOptionControls();
    wireDashboardControls();
    applyPermissions();
    if (can("automation")) startUpdatePolling();
    await loadAvailableData();
  } catch (error) {
    console.error(error);
    if (error.status === 401) return;
    if (can("overview")) {
      $("healthStatus").textContent = t("error");
      $("healthStatus").className = "status-pill error";
      $("kpiGrid").innerHTML = `<div class="empty-state">${esc(error.status === 403 ? t("accessDenied") : error.message)}</div>`;
    } else {
      $("loginError").textContent = error.status === 403 ? t("accessDenied") : error.message;
    }
  }
}

async function bootstrap() {
  wireShellControls();
  await setLanguage(state.language, { reload: false });
  try {
    const data = await api("/api/auth/me");
    if (!data.user) {
      showLogin();
      return;
    }
    state.user = data.user;
    showApp();
    await initDashboard();
  } catch (error) {
    console.error(error);
    showLogin(t("loginRequired"));
  }
}

bootstrap();
