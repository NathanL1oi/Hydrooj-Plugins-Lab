#ifndef HYDRO_TURTLE_DISPLAY_GOC_H
#define HYDRO_TURTLE_DISPLAY_GOC_H

#include <iomanip>
#include <iostream>

using namespace std;

#if defined(__GNUC__)
#define GOC_UNUSED __attribute__((unused))
#else
#define GOC_UNUSED
#endif

class GocPen {
public:
    GocPen& fd(double value) {
        std::cout << "turtle.forward(" << std::setprecision(12) << value << ")\n";
        return *this;
    }

    GocPen& bk(double value) {
        std::cout << "turtle.backward(" << std::setprecision(12) << value << ")\n";
        return *this;
    }

    GocPen& rt(double value) {
        std::cout << "turtle.right(" << std::setprecision(12) << value << ")\n";
        return *this;
    }

    GocPen& lt(double value) {
        std::cout << "turtle.left(" << std::setprecision(12) << value << ")\n";
        return *this;
    }

    GocPen& up() {
        std::cout << "turtle.penup()\n";
        return *this;
    }

    GocPen& down() {
        std::cout << "turtle.pendown()\n";
        return *this;
    }

    GocPen& c(int index) {
        std::cout << "_goc_set_color(" << index << ")\n";
        return *this;
    }

    GocPen& color(int index) {
        return c(index);
    }

    GocPen& size(double value) {
        std::cout << "turtle.pensize(" << std::setprecision(12) << value << ")\n";
        return *this;
    }

    GocPen& moveTo(double x, double y) {
        std::cout << "turtle.goto(" << std::setprecision(12) << x << ", " << y << ")\n";
        return *this;
    }

    GocPen& o(double radius) {
        std::cout << "_goc_circle(" << std::setprecision(12) << radius << ", False)\n";
        return *this;
    }

    GocPen& oo(double radius) {
        std::cout << "_goc_circle(" << std::setprecision(12) << radius << ", True)\n";
        return *this;
    }

    GocPen& r(double width, double height) {
        std::cout << "_goc_rect(" << std::setprecision(12) << width << ", " << height << ", False)\n";
        return *this;
    }

    GocPen& rr(double width, double height) {
        std::cout << "_goc_rect(" << std::setprecision(12) << width << ", " << height << ", True)\n";
        return *this;
    }

    GocPen& e(double radiusX, double radiusY) {
        std::cout << "_goc_ellipse(" << std::setprecision(12) << radiusX << ", " << radiusY << ", False)\n";
        return *this;
    }

    GocPen& ee(double radiusX, double radiusY) {
        std::cout << "_goc_ellipse(" << std::setprecision(12) << radiusX << ", " << radiusY << ", True)\n";
        return *this;
    }
};

static GocPen p GOC_UNUSED;
static GocPen pen GOC_UNUSED;

#undef GOC_UNUSED

#endif
