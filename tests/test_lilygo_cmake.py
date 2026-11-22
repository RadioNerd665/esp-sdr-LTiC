"""Verify ESP-IDF component requirements before and after Kconfig."""
from pathlib import Path
import shutil
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]


class LilygoComponentRequirements(unittest.TestCase):
    @unittest.skipUnless(shutil.which("cmake"), "CMake unavailable")
    def test_requirements_during_discovery_and_configuration(self):
        for target, config in (("esp32", None), ("esp32", "ON"),
                               ("esp32", "OFF"), ("esp32c3", None)):
            with self.subTest(target=target, config=config):
                command = ["cmake", f"-DIDF_TARGET={target}"]
                if config is not None:
                    command.append(f"-DCONFIG_ESP_SDR_LILYGO={config}")
                command.extend(["-P", str(ROOT / "tests/lilygo_component_requirements.cmake")])
                subprocess.run(command, cwd=ROOT, check=True)


if __name__ == "__main__":
    unittest.main()
