from pydantic import BaseModel,Field
class MeasurementOutput(BaseModel):
    source_key:str
    sequence:int
    measured_at:str
    value:float
    raw_value:float
    raw_unit:str

class MeasurementImportItem(BaseModel):
    source_key:str=Field(max_length=120)
    sequence:int=Field(ge=1,le=10000000)
    measured_at:str=Field(min_length=1,max_length=64)
    value:float=Field(allow_inf_nan=False)
    unit:str=Field(min_length=1,max_length=8)
    line:int|None=Field(default=None,ge=1,le=10000000)

class MeasurementImport(BaseModel):
    measurements:list[MeasurementImportItem]=Field(min_length=1,max_length=2000)

class ImportConflict(BaseModel):
    line:int
    source_key:str
    reason:str
    kind:str
    existing_lines:list[int]=Field(default_factory=list)

class MeasurementImportResult(BaseModel):
    stream_id:int
    unit:str
    inserted:int
    duplicates:int
    total:int
    duplicate_lines:list[int]=Field(default_factory=list)
