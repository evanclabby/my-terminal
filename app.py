import os, json, time, hashlib, threading, feedparser, requests
from functools import wraps
from flask import Flask, render_template, jsonify, request, session, redirect, url_for

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "change-this-in-production-abc123")

PASSWORD_HASH = os.environ.get("PASSWORD_HASH", hashlib.sha256("changeme".encode()).hexdigest())
FINNHUB_KEY   = os.environ.get("FINNHUB_KEY", "")
BASE          = "https://finnhub.io/api/v1"

# ── Auth ──────────────────────────────────────────────────────────────────────
def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated

@app.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        pw = request.form.get("password", "")
        if hashlib.sha256(pw.encode()).hexdigest() == PASSWORD_HASH:
            session["logged_in"] = True
            return redirect(url_for("index"))
        error = "Incorrect password"
    return render_template("login.html", error=error)

@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))

# ── Data ──────────────────────────────────────────────────────────────────────
WATCHLIST_FILE = "data/watchlist.json"
PORTFOLIO_FILE = "data/portfolio.json"
NOTES_FILE     = "data/notes.json"
ALERTS_FILE    = "data/alerts.json"

def load_json(path, default):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default

def save_json(path, data):
    os.makedirs("data", exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)

DEFAULT_WATCHLIST = [
    "BRK-B","GOOG","AMZN","MSFT","AAPL","ASML","AVGO","NVDA","LRCX","VRT",
    "ANET","SPGI","PANW","V","MA","GEV","BAM","PGR","LLY","JNJ","WM","TGT",
    "WMT","COST","HD","LOW","VICI","MAIN","PG","CL","CP","UNP","PEP","CAT",
    "SWK","UBER","UPS","SBUX"
]

DEFAULT_PORTFOLIO = [
    {"sym":"TSM",  "shares":9,    "avg_cost":160.91},
    {"sym":"JPM",  "shares":6,    "avg_cost":154.82},
    {"sym":"ASML", "shares":0.70, "avg_cost":698.24},
    {"sym":"V",    "shares":4,    "avg_cost":281.86},
    {"sym":"XOM",  "shares":5,    "avg_cost":107.89},
    {"sym":"KO",   "shares":10,   "avg_cost":58.89},
    {"sym":"AMZN", "shares":4.7,  "avg_cost":209.98},
    {"sym":"AVGO", "shares":3,    "avg_cost":218.34},
    {"sym":"ABBV", "shares":3,    "avg_cost":152.70},
    {"sym":"BN",   "shares":12,   "avg_cost":39.22},
    {"sym":"LRCX", "shares":1.25, "avg_cost":250.84},
    {"sym":"CEG",  "shares":0.5,  "avg_cost":258.45},
    {"sym":"SPGI", "shares":1.1,  "avg_cost":422.07},
    {"sym":"HHH",  "shares":2,    "avg_cost":70.22},
    {"sym":"OKLO", "shares":2,    "avg_cost":21.30},
]

# ── Finnhub helper ────────────────────────────────────────────────────────────
PROFILE_CACHE = {}
_detail_cache = {}
DETAIL_TTL    = 60 * 60

def fh_get(path, params={}):
    p = {"token": FINNHUB_KEY}
    p.update(params)
    r = requests.get(BASE + path, params=p, timeout=10)
    return r.json()

def get_profile(sym):
    if sym not in PROFILE_CACHE:
        try:
            p = fh_get("/stock/profile2", {"symbol": sym})
            PROFILE_CACHE[sym] = {"name": p.get("name", sym), "industry": p.get("finnhubIndustry",""), "logo": p.get("logo","")}
        except:
            PROFILE_CACHE[sym] = {"name": sym, "industry": "", "logo": ""}
    return PROFILE_CACHE[sym]

# ── News ──────────────────────────────────────────────────────────────────────
_news_cache = {"data": [], "last": 0}
NEWS_TTL = 30 * 60

RSS_FEEDS = [
    {"name":"MarketWatch Top",    "url":"https://feeds.content.dowjones.io/public/rss/mw_topstories",       "source":"MARKETWATCH"},
    {"name":"MarketWatch Markets","url":"https://feeds.content.dowjones.io/public/rss/mw_marketpulse",      "source":"MARKETWATCH"},
    {"name":"MarketWatch Invest", "url":"https://feeds.content.dowjones.io/public/rss/mw_investing",        "source":"MARKETWATCH"},
    {"name":"FT Markets",         "url":"https://www.ft.com/markets?format=rss",                           "source":"FT"},
    {"name":"FT Companies",       "url":"https://www.ft.com/companies?format=rss",                         "source":"FT"},
    {"name":"Seeking Alpha",      "url":"https://seekingalpha.com/market_currents.xml",                    "source":"SEEKINGALPHA"},
    {"name":"Yahoo Finance",      "url":"https://finance.yahoo.com/news/rssindex",                         "source":"YAHOO"},
    {"name":"Motley Fool",        "url":"https://www.fool.com/feeds/index.aspx",                           "source":"MOTLEYFOOL"},
]

SOURCE_MAP = {
    "marketwatch":"MARKETWATCH","wall street journal":"WSJ","wsj":"WSJ",
    "barron":"BARRONS","reuters":"REUTERS","cnbc":"CNBC","bloomberg":"BLOOMBERG",
    "seeking alpha":"SEEKINGALPHA","financial times":"FT","yahoo":"YAHOO",
    "motley fool":"MOTLEYFOOL","morningstar":"MORNINGSTAR","ap ":"AP",
    "associated press":"AP",
}

def _age_str(ts):
    delta = time.time() - ts
    if delta < 3600:  return f"{int(delta//60)}m ago"
    if delta < 86400: return f"{int(delta//3600)}h ago"
    return f"{int(delta//86400)}d ago"

def fetch_news():
    articles = []
    for feed in RSS_FEEDS:
        try:
            parsed = feedparser.parse(feed["url"])
            for entry in parsed.entries[:8]:
                pub = entry.get("published_parsed") or entry.get("updated_parsed")
                ts  = time.mktime(pub) if pub else time.time()
                articles.append({"source":feed["source"],"headline":entry.get("title",""),"link":entry.get("link","#"),"summary":entry.get("summary","")[:200],"timestamp":ts,"age":_age_str(ts)})
        except Exception as e:
            print(f"RSS {feed['name']}: {e}")
    try:
        items = fh_get("/news", {"category":"general"})
        for item in (items if isinstance(items,list) else [])[:60]:
            src_raw = (item.get("source") or "").lower()
            src = "NEWS"
            for k,v in SOURCE_MAP.items():
                if k in src_raw: src=v; break
            ts = item.get("datetime", time.time())
            hl = item.get("headline","")
            if hl:
                articles.append({"source":src,"headline":hl,"link":item.get("url","#"),"summary":item.get("summary","")[:200],"timestamp":ts,"age":_age_str(ts)})
    except Exception as e:
        print(f"Finnhub news: {e}")
    seen, unique = set(), []
    for a in sorted(articles, key=lambda x:x["timestamp"], reverse=True):
        k = a["headline"][:60].lower()
        if k not in seen and a["headline"]: seen.add(k); unique.append(a)
    return unique[:120]

def maybe_refresh_news():
    if time.time() - _news_cache["last"] > NEWS_TTL:
        def do(): _news_cache["data"]=fetch_news(); _news_cache["last"]=time.time()
        threading.Thread(target=do, daemon=True).start()

# ── Routes ────────────────────────────────────────────────────────────────────
@app.route("/")
@login_required
def index():
    maybe_refresh_news()
    return render_template("index.html")

# Price — called per symbol from frontend
@app.route("/api/price/<sym>")
@login_required
def api_price(sym):
    sym = sym.upper()
    try:
        q = fh_get("/quote", {"symbol":sym})
        price=q.get("c"); prev=q.get("pc")
        if not price: return jsonify({"sym":sym,"price":None})
        prof = get_profile(sym)
        return jsonify({"sym":sym,"name":prof["name"],"industry":prof["industry"],"price":round(price,2),"prev":round(prev,2),"change":round(price-prev,2),"pct":round((price-prev)/prev*100,2) if prev else 0,"high":q.get("h"),"low":q.get("l"),"open":q.get("o")})
    except:
        return jsonify({"sym":sym,"price":None})

# Watchlist
@app.route("/api/watchlist")
@login_required
def api_watchlist():
    return jsonify([{"sym":s} for s in load_json(WATCHLIST_FILE, DEFAULT_WATCHLIST)])

@app.route("/api/watchlist/add", methods=["POST"])
@login_required
def api_watchlist_add():
    sym=request.json.get("sym","").upper().strip()
    if not sym: return jsonify({"error":"No symbol"}),400
    wl=load_json(WATCHLIST_FILE,DEFAULT_WATCHLIST)
    if sym not in wl: wl.append(sym); save_json(WATCHLIST_FILE,wl)
    return jsonify({"ok":True})

@app.route("/api/watchlist/remove", methods=["POST"])
@login_required
def api_watchlist_remove():
    sym=request.json.get("sym","").upper().strip()
    save_json(WATCHLIST_FILE,[s for s in load_json(WATCHLIST_FILE,DEFAULT_WATCHLIST) if s!=sym])
    return jsonify({"ok":True})

# Portfolio
@app.route("/api/portfolio")
@login_required
def api_portfolio():
    return jsonify(load_json(PORTFOLIO_FILE,DEFAULT_PORTFOLIO))

@app.route("/api/portfolio/update", methods=["POST"])
@login_required
def api_portfolio_update():
    data=request.json; portfolio=load_json(PORTFOLIO_FILE,DEFAULT_PORTFOLIO)
    sym=data.get("sym","").upper()
    for h in portfolio:
        if h["sym"]==sym:
            h["shares"]=float(data.get("shares",h["shares"])); h["avg_cost"]=float(data.get("avg_cost",h["avg_cost"]))
            save_json(PORTFOLIO_FILE,portfolio); return jsonify({"ok":True})
    portfolio.append({"sym":sym,"shares":float(data["shares"]),"avg_cost":float(data["avg_cost"])})
    save_json(PORTFOLIO_FILE,portfolio); return jsonify({"ok":True})

@app.route("/api/portfolio/remove", methods=["POST"])
@login_required
def api_portfolio_remove():
    sym=request.json.get("sym","").upper()
    save_json(PORTFOLIO_FILE,[h for h in load_json(PORTFOLIO_FILE,DEFAULT_PORTFOLIO) if h["sym"]!=sym])
    return jsonify({"ok":True})

# News
@app.route("/api/news")
@login_required
def api_news():
    maybe_refresh_news()
    source=request.args.get("source","").upper()
    news=_news_cache.get("data",[])
    if not news: news=fetch_news(); _news_cache["data"]=news; _news_cache["last"]=time.time()
    if source and source!="ALL": news=[n for n in news if n["source"]==source]
    return jsonify(news[:60])

# Indices
@app.route("/api/indices")
@login_required
def api_indices():
    try:
        indices=[("^GSPC","S&P 500"),("^IXIC","NASDAQ"),("^DJI","DOW"),("^TNX","10Y"),("^VIX","VIX"),("GC=F","GOLD"),("CL=F","OIL")]
        result=[]
        for sym,label in indices:
            try:
                q=fh_get("/quote",{"symbol":sym}); time.sleep(0.15)
                price=q.get("c"); prev=q.get("pc")
                if price: pct=round((price-prev)/prev*100,2) if prev else 0; result.append({"label":label,"price":round(price,2),"pct":pct,"change":round(price-prev,2)})
            except: pass
        return jsonify(result)
    except: return jsonify([])

# Stock detail
@app.route("/api/stock/<sym>")
@login_required
def api_stock_detail(sym):
    sym=sym.upper()
    cached=_detail_cache.get(sym)
    if cached and time.time()-cached.get("_ts",0)<DETAIL_TTL: return jsonify(cached)
    try:
        q=fh_get("/quote",{"symbol":sym}); time.sleep(0.25)
        pr=fh_get("/stock/profile2",{"symbol":sym}); time.sleep(0.25)
        bf=fh_get("/stock/metric",{"symbol":sym,"metric":"all"}); time.sleep(0.25)
        pt=fh_get("/stock/price-target",{"symbol":sym}); time.sleep(0.25)
        rd=fh_get("/stock/recommendation",{"symbol":sym})
        m=bf.get("metric",{}); price=q.get("c"); prev=q.get("pc")
        rec=None
        if isinstance(rd,list) and rd:
            r0=rd[0]; buy=(r0.get("buy",0) or 0)+(r0.get("strongBuy",0) or 0)
            sell=(r0.get("sell",0) or 0)+(r0.get("strongSell",0) or 0); hold=r0.get("hold",0) or 0
            tot=buy+sell+hold
            if tot:
                if buy/tot>0.6: rec="buy"
                elif sell/tot>0.4: rec="sell"
                else: rec="hold"
        def gm(k): v=m.get(k); return round(float(v),4) if v is not None else None
        def pf(k): v=gm(k); return round(v/100,4) if v is not None else None
        detail={
            "_ts":time.time(),"sym":sym,"name":pr.get("name",sym),
            "sector":pr.get("finnhubIndustry"),"industry":pr.get("finnhubIndustry"),
            "exchange":pr.get("exchange"),"currency":pr.get("currency","USD"),
            "website":pr.get("weburl",""),"logo":pr.get("logo",""),
            "price":round(price,2) if price else None,"prev_close":round(prev,2) if prev else None,
            "day_high":q.get("h"),"day_low":q.get("l"),
            "week52_high":gm("52WeekHigh"),"week52_low":gm("52WeekLow"),
            "market_cap":(pr.get("marketCapitalization") or 0)*1e6 or None,
            "pe_ratio":gm("peBasicExclExtraTTM"),"forward_pe":gm("peNormalizedAnnual"),
            "peg_ratio":gm("pegRatio"),"price_book":gm("pbAnnual"),"ev_ebitda":gm("evEbitdaTTM"),
            "eps":gm("epsBasicExclExtraAnnual"),"forward_eps":gm("epsNormalizedAnnual"),
            "beta":gm("beta"),"analyst_target":pt.get("targetMean") if isinstance(pt,dict) else None,
            "num_analysts":pt.get("numberOfAnalysts") if isinstance(pt,dict) else None,
            "recommendation":rec,
            "gross_margin":pf("grossMarginTTM"),"op_margin":pf("operatingMarginTTM"),
            "net_margin":pf("netProfitMarginTTM"),"roe":pf("roeTTM"),"roa":pf("roaTTM"),
            "debt_equity":gm("totalDebt/totalEquityAnnual"),"current_ratio":gm("currentRatioAnnual"),
            "quick_ratio":gm("quickRatioAnnual"),"div_rate":gm("dividendPerShareAnnual"),
            "div_yield":pf("dividendYieldIndicatedAnnual"),"payout_ratio":pf("payoutRatioAnnual"),
            "div_growth_5y":pf("dividendGrowthRate5Y"),"revenue_growth":pf("revenueGrowthTTMYoy"),
            "earnings_growth":pf("epsGrowthTTMYoy"),"ex_div_date":None,"div_growth_10y":None,
        }
        _detail_cache[sym]=detail; return jsonify(detail)
    except Exception as e:
        return jsonify({"error":str(e),"sym":sym})

# Notes (scratchpad)
@app.route("/api/notes", methods=["GET"])
@login_required
def api_notes_get():
    return jsonify(load_json(NOTES_FILE, {"content":""}))

@app.route("/api/notes", methods=["POST"])
@login_required
def api_notes_save():
    data=request.json; save_json(NOTES_FILE,{"content":data.get("content",""),"updated":time.time()})
    return jsonify({"ok":True})

# Alerts
@app.route("/api/alerts", methods=["GET"])
@login_required
def api_alerts_get():
    return jsonify(load_json(ALERTS_FILE, []))

@app.route("/api/alerts/add", methods=["POST"])
@login_required
def api_alerts_add():
    data=request.json; alerts=load_json(ALERTS_FILE,[])
    alerts.append({"id":int(time.time()*1000),"sym":data.get("sym","").upper(),"condition":data.get("condition","above"),"price":float(data.get("price",0)),"created":time.time(),"triggered":False})
    save_json(ALERTS_FILE,alerts); return jsonify({"ok":True})

@app.route("/api/alerts/remove", methods=["POST"])
@login_required
def api_alerts_remove():
    aid=request.json.get("id"); alerts=[a for a in load_json(ALERTS_FILE,[]) if a["id"]!=aid]
    save_json(ALERTS_FILE,alerts); return jsonify({"ok":True})

if __name__ == "__main__":
    app.run(debug=True, port=5000)
