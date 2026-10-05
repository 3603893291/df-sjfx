#!/bin/bash
# 变异桩并行驱动（v1.8.1 这一轮之后固化下来的跑法）
#
# 为什么以前只能一套接一套跑：每个 test/mutate-*.js 都是「把源码改坏 → 跑测试看它报不报红 → 还原」，
# 两套同时在真树上跑 = 互相把对方的**桩态**当成自己的"原始文件"存进快照，最后谁还原都不对
# （2026-09-29 就这么烧掉过一次：读到的"npm test 1 项失败"是读到桩态的假红，树上还留了残留）。
#
# 这里的做法：每套桩分到一份自己的仓库副本，桩改的是副本里的文件 —— 真树一个字都不动，
# 于是可以真并行。墙钟从"各套之和"变成"最慢那一套"。副本约 3 MB（本项目零 npm 依赖）。
#
# 用法：
#   bash tools/run-mutations-parallel.sh                 # 默认全部十套
#   bash tools/run-mutations-parallel.sh backup gate camp # 只跑点名的几套
#   DFMUT_FROM_DIST=1 bash tools/run-mutations-parallel.sh …
#     ★ 真树此刻正被另一套桩改着时用它：core/shell/ui 直接从**最后一次好构建 dist** 取（那份不会被任何桩碰），
#       android/js 从 DFMUT_ANDROID_SRC 指的目录取（默认 /tmp/pristine181/android/js）。
#   DFMUT_KEEP=1 …  跑完不删副本，方便去副本里看现场。
set -u
cd "$(dirname "$0")/.." || exit 1
ROOTReal="$PWD"
APP="dist/三角洲全面战场分析器/resources/app"
WORK="${TMPDIR:-/tmp}/dfmut"
ALL="owner backup login-wipe store-io occupy-label kpm gate camp mapname sandbox"

live=$(powershell -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*mutate-*" } | Measure-Object | ForEach-Object { $_.Count }' 2>/dev/null | tr -d '\r')
if [ "${live:-0}" != "0" ] && [ "${DFMUT_FROM_DIST:-0}" != "1" ]; then
  echo "!! 树上有 $live 套桩正在跑 —— 默认不并行。确知差异只来自那套桩时，用 DFMUT_FROM_DIST=1 让副本从 dist 取源。"
  exit 3
fi

suites=("$@"); [ "${#suites[@]}" -eq 0 ] && suites=($ALL)
mkdir -p "$WORK"; rm -rf "$WORK"/mut-* 2>/dev/null
# 仓库外那枚夹具：test/*.js 与 tools/scan-dist.js 都按 `<仓根>/../df-analyzer/sample/sample_data.json` 读它。
# 副本的"上一层"就是 $WORK，所以放一份在这儿，所有副本共用（漏了它整只套件当场 ENOENT 崩掉，
# 而桩会把"没跑完"念成 RED —— 2026-09-29 第一版就栽在这，backup 报"18 针全变红"其实是测试根本没跑）。
mkdir -p "$WORK/df-analyzer/sample"
cp -f "$ROOTReal/../df-analyzer/sample/sample_data.json" "$WORK/df-analyzer/sample/" 2>/dev/null || {
  echo "!! 找不到仓库外的 sample_data.json（副本里套件会当场崩），停止。"; exit 4; }

make_copy() {  # $1 = 套名 → 打印副本目录
  local d="$WORK/mut-$1"
  rm -rf "$d"; mkdir -p "$d"
  # 顶层整份拷，只跳过"派生物 / 太大"那几个。★ 不能只拷 core/shell/ui/test/tools：
  #   android-shim 要读 android/app 里的 Java 与 plugins-dist 那两只 zip，scan-dist 要读仓库外的夹具 ——
  #   少一样，套件在副本里当场崩，而桩会把"没跑完"念成"这根针变红了"（2026-09-29 第一版就栽在这）。
  local e
  for e in *; do
    case "$e" in
      dist|dist-android|release|node_modules|backups|tmp-run-mutations.sh) continue ;;
      *) cp -r "$e" "$d/" ;;
    esac
  done
  find "$d/android" \( -name "*.lock" -o -name "build" -o -name ".gradle" \) -prune -exec rm -rf {} + 2>/dev/null
  if [ "${DFMUT_FROM_DIST:-0}" = "1" ]; then
    rm -rf "$d/core" "$d/shell" "$d/ui"
    cp -r "$APP/core" "$APP/shell" "$APP/ui" "$d/"
    local asrc="${DFMUT_ANDROID_SRC:-/tmp/pristine181/android/js}"
    cp -f "$asrc"/*.js "$d/android/js/"
  fi
  echo "$d"
}

pids=()
# ★ 一次最多两套：2026-09-29 三套并起来撞到 Windows 的进程创建上限
#   （child died unexpectedly, exit code 0xC000026B / fork: Resource temporarily unavailable），
#   那一份记录整个作废（桩"跑完了"但套件没起来）。每套里面还要开两只测试进程，所以 2 是安全的上限。
MAXJOB=2
for s in "${suites[@]}"; do
  # 节流：在跑的套数到顶就先等一批（超过 MAXJOB 会撞上面那条进程创建上限）
  while [ "$(jobs -rp | wc -l)" -ge "$MAXJOB" ]; do sleep 10; done
  d=$(make_copy "$s")
  [ -f "$d/test/mutate-$s.js" ] || { echo "!! $s 没有对应桩脚本，跳过"; continue; }
  ( cd "$d" &&
    # 预检：副本里基线必须先绿一次。不预检的话，"套件压根没跑成"会被桩念成"这根针变红了"
    # （2026-09-29 那版就是这么把 18 针的空崩溃读成全绿的），所以这一步不许省。
    if ! node test/core.test.js > "$WORK/$s.preflight.log" 2>&1 ||
       ! grep -q "全部通过" "$WORK/$s.preflight.log" ||
       ! node test/android-shim.test.js >> "$WORK/$s.preflight.log" 2>&1 ||
       ! grep -q "全部通过" "$WORK/$s.preflight.log"; then
      echo "!! $s 副本基线不绿，结论不能用（见 $WORK/$s.preflight.log）" > "$WORK/$s.log"
      echo 98 > "$WORK/$s.exit"
    else
      node "test/mutate-$s.js" > "$WORK/$s.log" 2>&1; echo $? > "$WORK/$s.exit"
    fi ) &
  pids+=("$!")
  echo "起跑 $s → $d (pid $!)"
done
wait
echo "=== 汇总 ==="
bad=0
for s in "${suites[@]}"; do
  [ -f "$WORK/$s.log" ] || continue
  ex=$(cat "$WORK/$s.exit" 2>/dev/null || echo '?')
  red=$(grep -c "→ RED" "$WORK/$s.log")
  miss=$(grep -c "没变红" "$WORK/$s.log")
  nohit=$(grep -c "变异没打上" "$WORK/$s.log")
  after=$(grep -o "还原后：.*" "$WORK/$s.log" | tail -1 | cut -c1-46)
  printf '%-13s exit=%s 变红=%s 没咬住=%s 打不上=%s  %s\n' "$s" "$ex" "$red" "$miss" "$nohit" "$after"
  [ "$ex" = "0" ] || bad=1
  grep -E "没变红|变异没打上" "$WORK/$s.log" | head -3
done
# 副本是副本，真树必须一个字都没变：跑完再对一次最后一次好构建
echo "=== 真树 vs dist（必须没有输出）==="
for d in core shell ui; do diff -rq "$APP/$d" "$d"; done
[ "$bad" = "0" ] || echo "!! 有套件退出码非 0，看 $WORK/<套>.log"
[ "${DFMUT_KEEP:-0}" = "1" ] || rm -rf "$WORK"/mut-*
echo "副本工作区：$WORK"
