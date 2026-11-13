import math
from datetime import datetime,timezone
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from ..models import Measurement
from ..utils.serialize import record
from .audit_service import log
from .stream_service import get_stream

MICRON="μm";NANOMETER="nm";PRECISION=6;CHUNK=400;RETRIES=3
UNIT_ALIASES={
    "μm":MICRON,"µm":MICRON,"um":MICRON,"微米":MICRON,"micron":MICRON,"microns":MICRON,"micrometer":MICRON,"micrometre":MICRON,
    "nm":NANOMETER,"纳米":NANOMETER,"nanometer":NANOMETER,"nanometre":NANOMETER,
}

def list_measurements(db,sid):
    get_stream(db,sid)
    return [record(x) for x in db.query(Measurement).filter_by(stream_id=sid).order_by(Measurement.sequence)]

def normalize_unit(raw):
    unit=UNIT_ALIASES.get(str(raw).strip().lower())
    if not unit:raise ValueError("单位仅支持微米(μm)或纳米(nm)")
    return unit

def normalize_time(raw):
    text_value=str(raw).strip()
    try:
        parsed=datetime.fromisoformat(text_value[:-1]+"+00:00" if text_value[-1:] in ("Z","z") else text_value)
    except ValueError:raise ValueError("采样时间必须为ISO 8601时间，例如 2026-11-01T08:00:00+00:00")
    if parsed.tzinfo is None:parsed=parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()

def canonical_item(item,line):
    source_key=item.source_key.strip()
    if not source_key:raise ValueError("来源编号不能为空")
    unit=normalize_unit(item.unit)
    value=float(item.value)
    if not math.isfinite(value) or value<=0:raise ValueError("读数必须为大于0的有限数字")
    canonical=value/1000.0 if unit==NANOMETER else value
    if not math.isfinite(canonical) or canonical>1e9:raise ValueError("换算后的微米读数超出支持范围")
    return {"source_key":source_key,"sequence":item.sequence,"measured_at":normalize_time(item.measured_at),"unit":unit,"raw_value":value,"value":canonical,"canonical":round(canonical,PRECISION),"line":line}

def _issue(line,source_key,kind,reason,existing_lines=None):
    return {"line":line,"source_key":source_key,"kind":kind,"reason":reason,"existing_lines":existing_lines or []}

def _existing_label(row):
    unit=getattr(row,"raw_unit",None) or MICRON
    raw=getattr(row,"raw_value",None)
    shown=f"{raw} {unit}" if raw is not None else f"{row.value} {MICRON}"
    return f"已存 {row.source_key} / #{row.sequence} / {normalize_time(row.measured_at)} / {shown}"

def _lock(db,stream_id):
    if db.get_bind().dialect.name=="postgresql":
        db.execute(text("select pg_advisory_xact_lock(7361,:sid)"),{"sid":int(stream_id)})

def _rows_by_key(db,keys):
    found={}
    keys=list(keys)
    for start in range(0,len(keys),CHUNK):
        chunk=keys[start:start+CHUNK]
        for row in db.query(Measurement).filter(Measurement.source_key.in_(chunk)):found[row.source_key]=row
    return found

def _rows_by_sequence(db,stream_id,sequences):
    found={}
    sequences=list(sequences)
    for start in range(0,len(sequences),CHUNK):
        chunk=sequences[start:start+CHUNK]
        for row in db.query(Measurement).filter(Measurement.stream_id==stream_id,Measurement.sequence.in_(chunk)):found[row.sequence]=row
    return found

def _same_record(row,item,existing_time):
    return round(row.value,PRECISION)==item["canonical"] and row.sequence==item["sequence"] and existing_time==item["measured_at"]

def _classify(stream,items,rows_by_key,rows_by_sequence):
    conflicts=[];duplicates=0;duplicate_lines=[];accepted=[];seen_key={};seen_sequence={}
    for item in items:
        line=item["line"];key=item["source_key"]
        if key in seen_key:
            original=seen_key[key]
            if (original["canonical"],original["sequence"],original["measured_at"])==(item["canonical"],item["sequence"],item["measured_at"]):
                duplicates+=1;duplicate_lines.append(line);continue
            conflicts.append(_issue(line,key,"duplicate_conflict",f"与批内第 {original['line']} 行同一来源编号，但读数、采样时间或时间序号不一致",[original["line"]]))
            continue
        if item["sequence"] in seen_sequence:
            original=seen_sequence[item["sequence"]]
            conflicts.append(_issue(line,key,"sequence_conflict",f"时间序号 #{item['sequence']} 与批内第 {original['line']} 行的 {original['source_key']} 重复",[original["line"]]))
            continue
        existing_key=rows_by_key.get(key)
        existing_sequence=rows_by_sequence.get(item["sequence"])
        if existing_key is not None:
            if existing_key.stream_id!=stream.id:
                conflicts.append(_issue(line,key,"stream_conflict",f"来源编号已属于其他测量流，{_existing_label(existing_key)}"))
                continue
            existing_time=normalize_time(existing_key.measured_at)
            if _same_record(existing_key,item,existing_time):
                duplicates+=1;duplicate_lines.append(line);continue
            reasons=[]
            if round(existing_key.value,PRECISION)!=item["canonical"]:reasons.append("数值")
            if existing_key.sequence!=item["sequence"]:reasons.append("时间序号")
            if existing_time!=item["measured_at"]:reasons.append("采样时间")
            conflicts.append(_issue(line,key,"key_conflict",f"同一来源编号的{('、'.join(reasons))}与已有记录冲突，{_existing_label(existing_key)}；换单位后按微米等值比较"))
            continue
        if existing_sequence is not None:
            conflicts.append(_issue(line,key,"sequence_conflict",f"时间序号 #{item['sequence']} 已被 {_existing_label(existing_sequence)} 占用"))
            continue
        seen_key[key]=item;seen_sequence[item["sequence"]]=item;accepted.append(item)
    return conflicts,duplicates,duplicate_lines,accepted

def _rejected(status,message,conflicts):
    return HTTPException(status,{"message":message,"conflicts":conflicts})

def import_measurements(db,sid,data,user):
    stream=get_stream(db,sid)
    items=[]
    for index,item in enumerate(data.measurements,1):
        line=item.line or index
        try:items.append(canonical_item(item,line))
        except ValueError as e:
            reason=f"{e}；整批已拒绝，未写入任何样本"
            raise _rejected(422,f"第 {line} 行 / {item.source_key or '空编号'}：{reason}",[_issue(line,item.source_key,"invalid_input",reason)])
    _lock(db,stream.id)
    for _attempt in range(RETRIES):
        rows_by_key=_rows_by_key(db,{item["source_key"] for item in items})
        rows_by_sequence=_rows_by_sequence(db,stream.id,{item["sequence"] for item in items})
        conflicts,duplicates,duplicate_lines,accepted=_classify(stream,items,rows_by_key,rows_by_sequence)
        if conflicts:
            raise _rejected(409,f"检测到 {len(conflicts)} 处冲突，整批已拒绝，未写入任何样本；请按原行修正后重传。",conflicts)
        try:
            with db.begin_nested():
                for item in accepted:
                    db.add(Measurement(stream_id=stream.id,source_key=item["source_key"],sequence=item["sequence"],measured_at=item["measured_at"],value=item["value"],raw_value=item["raw_value"],raw_unit=item["unit"]))
                db.flush()
        except IntegrityError:
            continue
        log(db,user.email,"measurement.import",f"{stream.code}:+{len(accepted)}/dup{duplicates}")
        db.commit()
        return {"stream_id":stream.id,"unit":MICRON,"inserted":len(accepted),"duplicates":duplicates,"total":len(items),"duplicate_lines":duplicate_lines}
    raise _rejected(409,"并发写入冲突，整批已拒绝，未写入任何样本；请重试。",[])
