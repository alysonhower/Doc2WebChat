from enum import StrEnum


class OcrEventStage(StrEnum):
    DISCOVERY = "discovery"
    PLAN_VALIDATION = "plan-validation"
    OVERWRITE_CONFIRMATION_REQUIRED = "overwrite-confirmation-required"
    QUEUED = "queued"
    SERVER_STARTUP = "server-startup"
    OCR_PROCESSING = "ocr-processing"
    WRITING = "writing"
    EXTRACTING = "extracting"
    PERSISTING = "persisting"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    PROGRESS = "progress"
    JOB_FINISHED = "job-finished"
    JOB_FAILED = "job-failed"


class OcrJobStatus(StrEnum):
    PENDING = "pending"
    DISCOVERING = "discovering"
    PLANNING = "planning"
    AWAITING_OVERWRITE = "awaiting-overwrite"
    OVERWRITE_CLAIMED = "overwrite-claimed"
    OVERWRITE_CONFIRMED = "overwrite-confirmed"
    OVERWRITE_DECLINED = "overwrite-declined"
    STARTING_SERVER = "starting-server"
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_ERRORS = "completed-with-errors"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


class OcrDocumentStatus(StrEnum):
    COMPLETED = "completed"
    OCR_FAILED = "ocr-failed"
    WRITE_FAILED = "write-failed"
    EXTRACT_FAILED = "extract-failed"
    PROCESSING_FAILED = "processing-failed"
    BATCH_FAILED = "batch-failed"


class OcrFileStage(StrEnum):
    QUEUED = "queued"
    AWAITING_OVERWRITE = "awaiting-overwrite"
    OVERWRITE_CLAIMED = "overwrite-claimed"
    OVERWRITE_CONFIRMED = "overwrite-confirmed"
    OVERWRITE_DECLINED = "overwrite-declined"
    OCR_PROCESSING = "ocr-processing"
    WRITING = "writing"
    EXTRACTING = "extracting"
    PERSISTING = "persisting"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    INTERRUPTED = "interrupted"


class OcrFileStatus(StrEnum):
    QUEUED = "queued"
    AWAITING_OVERWRITE = "awaiting-overwrite"
    OVERWRITE_CLAIMED = "overwrite-claimed"
    OVERWRITE_CONFIRMED = "overwrite-confirmed"
    OVERWRITE_DECLINED = "overwrite-declined"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"
    INTERRUPTED = "interrupted"


OCR_CONTRACT_ENUMS = (
    OcrEventStage,
    OcrJobStatus,
    OcrDocumentStatus,
    OcrFileStage,
    OcrFileStatus,
)
