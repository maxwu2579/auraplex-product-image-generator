"""Local image-processing API."""

import base64
import logging
import os
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response

from app.brand_library import BrandConflictError, BrandLibrary, BrandLibraryError, BrandNotFoundError
from app.image_processing.service import InvalidImageError, NoForegroundError, process_image
from app.image_processing.subjects import process_subjects

logger = logging.getLogger(__name__)
app = FastAPI(title="Auraplex Image Processing", version="0.2.0")

MAX_UPLOAD_BYTES = 10 * 1024 * 1024
ALLOWED_MEDIA_TYPES = {"image/jpeg", "image/png", "image/webp"}
brand_library = BrandLibrary(Path(os.environ.get("AURAPLEX_BRAND_LIBRARY_ROOT", Path(__file__).resolve().parents[2] / "data" / "brand_logos")))


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


async def _read_upload(file: UploadFile) -> bytes:
    if file.content_type not in ALLOWED_MEDIA_TYPES:
        raise HTTPException(status_code=415, detail="仅支持 JPG、PNG 或 WEBP 图片。")

    try:
        content = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="每张图片不能超过 10 MB。")
    if not content:
        raise HTTPException(status_code=422, detail="图片文件为空。")
    return content


def _brand_error(exc: BrandLibraryError) -> HTTPException:
    status = 409 if isinstance(exc, BrandConflictError) else 404 if isinstance(exc, BrandNotFoundError) else 422
    if "索引" in str(exc) or "文件缺失" in str(exc) or "无法保存" in str(exc):
        status = 503
    return HTTPException(status_code=status, detail=str(exc))


@app.get("/api/brands/{brand}")
def get_brand(brand: str) -> dict:
    try:
        return brand_library.lookup(brand)
    except BrandLibraryError as exc:
        raise _brand_error(exc) from exc


@app.get("/api/brands/{brand}/assets/{kind}")
def get_brand_asset(brand: str, kind: str) -> FileResponse:
    if kind not in ("original", "display"):
        raise HTTPException(status_code=404, detail="Logo 文件不存在。")
    try:
        path = brand_library.asset(brand, kind)
    except BrandLibraryError as exc:
        raise _brand_error(exc) from exc
    media_type = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}[path.suffix]
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


async def _save_brand(brand: str, display_name: str, file: UploadFile, processed_file: UploadFile | None,
                      remove_background: bool, replace: bool) -> dict:
    original_type = file.content_type or ""
    original = await _read_upload(file)
    processed_type = processed_file.content_type if processed_file else None
    processed = await _read_upload(processed_file) if processed_file else None
    try:
        return await run_in_threadpool(brand_library.save, brand, display_name, original, original_type,
                                       processed, processed_type, remove_background, replace=replace)
    except BrandLibraryError as exc:
        raise _brand_error(exc) from exc


@app.post("/api/brands/{brand}")
async def save_brand(brand: str, display_name: Annotated[str, Form()], remove_background: Annotated[bool, Form()],
                     file: Annotated[UploadFile, File()], processed_file: Annotated[UploadFile | None, File()] = None) -> dict:
    return await _save_brand(brand, display_name, file, processed_file, remove_background, False)


@app.put("/api/brands/{brand}")
async def replace_brand(brand: str, display_name: Annotated[str, Form()], remove_background: Annotated[bool, Form()],
                        file: Annotated[UploadFile, File()], processed_file: Annotated[UploadFile | None, File()] = None) -> dict:
    return await _save_brand(brand, display_name, file, processed_file, remove_background, True)


@app.post("/api/images/remove-background", responses={200: {"content": {"image/png": {}}}})
async def remove_background_image(file: Annotated[UploadFile, File()]) -> Response:
    content = await _read_upload(file)

    try:
        png = await run_in_threadpool(process_image, content)
    except InvalidImageError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except NoForegroundError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Local background removal failed")
        raise HTTPException(status_code=503, detail="背景处理失败；请检查本机模型和后端日志。") from exc

    return Response(content=png, media_type="image/png", headers={"Cache-Control": "no-store"})


@app.post("/api/images/detect-subjects")
async def detect_subjects_image(file: Annotated[UploadFile, File()]) -> JSONResponse:
    content = await _read_upload(file)
    try:
        result = await run_in_threadpool(process_subjects, content)
    except (InvalidImageError, NoForegroundError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Local subject processing failed")
        raise HTTPException(status_code=503, detail="图像处理失败；请检查本机模型和后端日志。") from exc

    def image_payload(item: dict) -> dict:
        return {key: value for key, value in item.items() if key != "png"} | {"pngBase64": base64.b64encode(item["png"]).decode("ascii")}

    return JSONResponse(
        {"whole": image_payload(result["whole"]), "candidates": [image_payload(item) for item in result["candidates"]], "warning": result["warning"]},
        headers={"Cache-Control": "no-store"},
    )
