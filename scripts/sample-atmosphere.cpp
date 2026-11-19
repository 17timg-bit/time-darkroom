// Sample the Prague Sky Model on the grid used by the darkroom shader.
// Compile against the upstream PragueSkyModel.cpp and header, then pass the
// Ground dataset and a destination for the RGB float samples.
#include "PragueSkyModel.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <iostream>

namespace {
constexpr double radians = 0.017453292519943295;
constexpr double visibility = 45.0;
constexpr double albedo = 0.18;

// Wyman, Sloan and Shirley's piecewise Gaussian approximation of CIE 1931.
double gaussian(double wavelength, double peak, double left, double right) {
    const double x = (wavelength - peak) * (wavelength < peak ? left : right);
    return std::exp(-0.5 * x * x);
}

std::array<double, 3> response(double w) {
    return {
        0.362 * gaussian(w, 442.0, 0.0624, 0.0374)
            + 1.056 * gaussian(w, 599.8, 0.0264, 0.0323)
            - 0.065 * gaussian(w, 501.1, 0.0490, 0.0382),
        0.821 * gaussian(w, 568.8, 0.0213, 0.0247)
            + 0.286 * gaussian(w, 530.9, 0.0613, 0.0322),
        1.217 * gaussian(w, 437.0, 0.0845, 0.0278)
            + 0.681 * gaussian(w, 459.0, 0.0385, 0.0725)
    };
}
}

int main(int argc, char** argv) {
    if (argc != 3) {
        std::cerr << "usage: sample-atmosphere Ground.dat radiance.bin\n";
        return 1;
    }
    PragueSkyModel model;
    model.initialize(argv[1], visibility);
    std::ofstream output(argv[2], std::ios::binary);
    using Vec = PragueSkyModel::Vector3;
    for (int sun = -4; sun <= 52; ++sun) {
        for (int row = 0; row < 20; ++row) {
            const double up = 0.8 * row / 19.0;
            const double flat = std::sqrt(1.0 - up * up);
            for (int col = 0; col < 48; ++col) {
                const double azimuth = -1.0 + 2.0 * col / 47.0;
                const Vec ray = Vec(flat * azimuth, flat * std::sqrt(1.0 - azimuth * azimuth), up);
                const auto direction = model.computeParameters(Vec(0, 0, 0), ray, sun * radians, 0.0, visibility, albedo);
                std::array<double, 3> xyz{};
                for (int w = 380; w <= 720; w += 10) {
                    const double radiance = model.skyRadiance(direction, w) * 10.0;
                    const auto cmf = response(w);
                    for (int c = 0; c < 3; ++c) xyz[c] += radiance * cmf[c];
                }
                const auto [x, y, z] = xyz;
                const std::array<float, 3> rgb{
                    float(std::max(0.0, 3.24045 * x - 1.53714 * y - 0.49853 * z)),
                    float(std::max(0.0, -0.96927 * x + 1.87601 * y + 0.04156 * z)),
                    float(std::max(0.0, 0.05564 * x - 0.20403 * y + 1.05723 * z))
                };
                output.write(reinterpret_cast<const char*>(rgb.data()), sizeof(rgb));
            }
        }
    }
    return output ? 0 : 1;
}
